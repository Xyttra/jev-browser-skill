#!/usr/bin/env node
// Jev drives a browser. Zero dependencies: Node 22+ and any Chromium-based browser.
//
//   observe page → Jev picks an operation and a target → code executes it → repeat
//
// core.mjs    the interesting part: what Jev is asked and how its answer is validated
// browser.mjs the plumbing: Chrome DevTools Protocol client, launch or attach
// this file   the loop, the command line, the log, and --trace

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { blockReason, coveredRun, decide, fingerprint, verdict } from "./core.mjs";
import { Chrome, sleep } from "./browser.mjs";

const API = "https://api.typesafe.ai/v1/systemone";
const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  for (const file of [join(SKILL_DIR, ".env"), join(homedir(), ".typesafe")]) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, "utf8").match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    if (match) return match[1];
  }
  throw new Error(`TYPESAFE_API_KEY is not set. Export it, or put TYPESAFE_API_KEY=... in ${join(SKILL_DIR, ".env")}`);
}

/** One request to Jev: POST the body, get back a choice and a probability per option for every question. */
async function askJev(key, body) {
  const started = performance.now();
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(API, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (![429, 503, 529].includes(response.status)) break;
    await sleep(500 * 2 ** attempt);
  }
  if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const { answers, usage } = await response.json();
  const ms = Math.round(performance.now() - started);
  if (process.env.JEV_DEBUG) console.error(`   jev: ${usage?.input_tokens} tokens, ${Object.keys(body.questions).join(" + ")}, ${ms}ms`);
  return { answers, usage, ms };
}

const top = (probabilities, name = k => k) => Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4)
  .map(([k, v]) => `${name(k)} ${v.toFixed(2)}`).join(", ");

async function main() {
  const { values: args } = parseArgs({
    options: {
      url: { type: "string" },
      goal: { type: "string" },
      text: { type: "string", multiple: true, default: [] },
      secret: { type: "string" },
      "max-steps": { type: "string", default: "100" },
      screenshot: { type: "string" },
      trace: { type: "string" },
      browser: { type: "string", default: "auto" },
      headless: { type: "boolean", default: false },
      close: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (args.help || !args.url || !args.goal) {
    console.log(`Usage: jev.mjs --url <url> --goal "<goal>" [--text "<value to type>"]...

  --text <value>       A string Jev may type into a field. Repeat for several values.
  --secret <value>     A string typed only into password fields. Never sent to Jev, never printed.
  --max-steps <n>      Stop after n actions (default 100).
  --screenshot <png>   Save a screenshot of the final page.
  --trace <json>       Save every step: page table, request, answers, decision, screenshot.
  --browser <mode>     auto (default): your own browser when it allows remote debugging, else a Jev window.
                       yours: your own browser, or fail with setup instructions.
                       own: the Jev window, a dedicated Chrome with its own persistent profile.
                       host:port: any browser started with --remote-debugging-port.
  --headless           Run without a window (implies --close).
  --close              Close the tab or window when finished. By default it stays open.`);
    process.exit(args.help ? 0 : 2);
  }
  const key = apiKey();
  const ask = body => askJev(key, body);
  const model = process.env.TYPESAFE_MODEL || "jev-latest";
  const url = /^[a-z]+:/i.test(args.url) ? args.url : `https://${args.url}`;
  const maxSteps = Number(args["max-steps"]) || 100;
  fetch(API, { method: "HEAD" }).catch(() => {}); // open the TLS connection to Jev while the browser starts
  const chrome = await Chrome.open(args.browser, { headless: args.headless });
  const history = [], trace = { goal: args.goal, texts: args.text, secret: Boolean(args.secret), url, model, steps: [] };
  let status = "max_steps", blocked, coveredBy, modelMs = 0, page, unsure;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  try {
    await chrome.goto(url);
    while (history.length < maxSteps) {
      page = await chrome.observe();
      if (history.length) history.at(-1).page_changed ??= history.at(-1).fingerprint !== fingerprint(page);
      const stuck = history.filter(h => !h.missed).slice(-3); // a skipped click is not the page ignoring us
      if (stuck.length === 3 && stuck.every(h => h.page_changed === false)) {
        status = "blocked"; blocked = "no_progress";
        console.log("   blocked: the last three steps changed nothing on the page");
        break;
      }
      if (page.omitted) console.error(`   warning: ${page.omitted} controls beyond the first 250 were not offered to Jev (255-choice limit per question)`);

      const shot = args.trace ? await chrome.traceScreenshot() : { screenshot: null };
      const decision = await decide(ask, { goal: args.goal, page, texts: args.text, secret: args.secret, history, model });
      modelMs += decision.ms;
      const { operation, e, option, text } = decision;
      const shown = decision.secret ? "••••••" : text;
      const label = e ? `${e.role} "${e.label}"` + (option ? ` → "${option.label}"` : "") + (text ? ` ← "${shown}"` : "") : "";
      console.log(`${String(trace.steps.length + 1).padStart(2)}  ${operation.padEnd(11)} ${label.padEnd(58).slice(0, 58)}  p=${decision.p.toFixed(2)}  ${String(decision.ms).padStart(4)}ms  +${(elapsed() / 1000).toFixed(1)}s`);
      const checks = Object.entries(decision.checks).map(([k, v]) => `${k} ${v?.toFixed(2) ?? "?"}`).join(", ");
      if (process.env.JEV_DEBUG) {
        console.error("   checks: " + checks);
        console.error("   ops: " + top(decision.probabilities.operation));
        if (decision.probabilities.target) console.error("   targets: " + top(decision.probabilities.target, k => `[${k}] ${page.elements[Number(k.split(":")[0]) - 1].label}`));
      }
      trace.steps.push({
        elapsed_ms: elapsed(), page: { ...page, screenshot: shot.screenshot }, ...(shot.screenshot_error ? { screenshot_error: shot.screenshot_error } : {}), calls: decision.calls,
        decision: { operation, target: e && `[${e.index}] ${e.role} "${e.label}"`, option: option?.label, text: shown, p: decision.p, operation_p: decision.operation_p, checks: decision.checks, probabilities: decision.probabilities, ms: decision.ms },
      });
      const stop = verdict(decision);
      if (stop === "unsure") { // too unsure to act alone: stop and hand the choice to the caller
        console.log(`   unsure: ${checks}; nothing was done on this step`);
        unsure = {
          proposed: operation + (e ? ` ${e.role} "${e.label}"` : "") + (option ? ` → "${option.label}"` : ""),
          operation_p: +decision.operation_p.toFixed(2), checks: decision.checks,
          operations: top(decision.probabilities.operation),
          ...(decision.probabilities.target ? { targets: top(decision.probabilities.target, k => `[${k}] ${page.elements[Number(k.split(":")[0]) - 1].label}`) } : {}),
        };
      }
      if (stop === "blocked") {
        blocked = trace.steps.at(-1).blocked_reason = blockReason(decision);
        console.log(`   blocked: ${blocked === "jev_blocked" ? "Jev answered BLOCKED" : "the stuck check reached the stop bar"} (${checks})`);
      }
      if (stop) { status = stop; break; }

      // Not actionable: record the miss so Jev sees it and the target stops being offered. True
      // when it ends the run: three skips in a row, e.g. under a consent pop-up.
      const skipped = async () => {
        const cover = trace.steps.at(-1).covered_by = await chrome.coveredBy(e.node);
        trace.steps.at(-1).executed = false;
        console.log(`   skipped: the target was covered or off screen, so nothing was clicked (on top: ${cover})`);
        history.push({ operation, target: `${e.role} "${e.label}"`, text: shown, url: page.url, fingerprint: fingerprint(page), page_changed: false, missed: true });
        if (!coveredRun(history)) return false;
        status = "blocked"; blocked = trace.steps.at(-1).blocked_reason = "covered"; coveredBy = cover;
        console.log(`   blocked: three targets in a row were covered; on top: ${cover}`);
        return true;
      };
      let acted = 0;
      if (e) {
        const aims = operation !== "SELECT"; // a SELECT needs no coordinates
        let point = await chrome.locate(e.node, args.headless ? "" : `Jev · ${operation} · ${Math.round(decision.p * 100)}%`, aims);
        if (!point) { // covered, often by a hover menu the pointer left open: move it away, look once more
          await chrome.park();
          await chrome.settle();
          point = await chrome.locate(e.node, "", aims);
        }
        if (!point) { if (await skipped()) break; continue; }
        if (!args.headless) { // the highlight pause is long enough for a busy page to reflow
          await sleep(300);
          point = (await chrome.locate(e.node, "", aims)) ?? point;
        }
        acted = performance.now();
        if (operation === "SELECT") await chrome.select(e.node, option.value);
        else {
          const landed = await chrome.click(point, undefined, e.node);
          // false: the hover put something over the whole target, so nothing was pressed
          if (landed === false) { if (await skipped()) break; continue; }
          trace.steps.at(-1).landed = landed;
          if (process.env.JEV_DEBUG && landed?.on_target === false) {
            console.error(`   warning: the click landed on ${landed.click ?? landed.mousedown ?? "nothing"}, not on the target`);
          }
        }
        if (operation === "TYPE") {
          await chrome.type(e.node, text);
          await chrome.awaitSuggestions(e.node); // so the next observe sees the suggestion list
        }
      } else if (operation === "ENTER") { acted = performance.now(); await chrome.enter(); }
      else trace.steps.at(-1).waited_ms = await chrome.waitForChange(page); // WAIT: until the page changes, up to 5s
      trace.steps.at(-1).executed = true;

      history.push({ operation, target: e && `${e.role} "${e.label}"`, text: shown, url: page.url, href: e?.href, fingerprint: fingerprint(page) });
      if (acted) await chrome.react(page, acted, e?.href);
      await chrome.settle();
    }
    page = await chrome.observe();
    if (args.screenshot) {
      let png;
      try { png = await chrome.screenshot("png"); } catch (error) { throw new Error(`could not save the --screenshot file: ${error.message}`); }
      writeFileSync(args.screenshot, png);
    }
  } finally {
    if (args.headless || args.close) await chrome.close();
    else chrome.socket.close();
  }

  const result = {
    status,
    steps: history.length,
    seconds: +(elapsed() / 1000).toFixed(1),
    jev_seconds: +(modelMs / 1000).toFixed(2),
    url: page.url,
    title: page.title,
    ...(blocked ? { blocked_reason: blocked } : {}),
    ...(coveredBy ? { covered_by: coveredBy } : {}),
    ...(unsure ? { unsure } : {}),
    ...(args.screenshot ? { screenshot: args.screenshot } : {}),
    page_text: page.text.slice(0, 2500),
  };
  if (args.trace) writeFileSync(args.trace, JSON.stringify({ ...trace, result }));
  console.log("\n" + JSON.stringify(result, null, 2));
  process.exit(status === "done" ? 0 : 1);
}

main().catch(error => {
  console.error(`jev-browser: ${error.message}`);
  process.exit(1);
});
