// A hidden browser must never outlive the run that started it. Real Chrome; no network, no Jev.
// Skipped when no Chromium-based browser is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Chrome, findBinary, sleep } from "../scripts/browser.mjs";

const BROWSER = pathToFileURL(join(import.meta.dirname, "..", "scripts", "browser.mjs")).href;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function gone(pid, ms = 10000) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  return !alive(pid);
}

async function withProfile(t, body) {
  const profile = mkdtempSync(join(tmpdir(), "jev-hidden-"));
  try { await body(profile); } finally {
    await sleep(300); // let Chrome release the profile before removing it
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test("a hidden browser quits when the run is killed before its own clean-up", async t => {
  await withProfile(t, async profile => {
    // A run in its own process, stopped the way a timed-out or cancelled command is: only that process.
    const script = `const { Chrome } = await import(${JSON.stringify(BROWSER)});
      const chrome = await Chrome.launch({ headless: true, profile: ${JSON.stringify(profile)} });
      console.log("chrome " + chrome.child.pid); setInterval(() => {}, 1000);`;
    const run = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    run.stdout.on("data", d => out += d);
    run.stderr.on("data", d => err += d);
    const deadline = Date.now() + 20000;
    while (!/chrome \d+/.test(out) && run.exitCode === null && Date.now() < deadline) await sleep(50);
    const pid = Number(out.match(/chrome (\d+)/)?.[1]);
    if (!pid) {
      run.kill();
      if (/No Chromium-based browser/.test(err)) return t.skip("no browser");
      assert.fail(`the run did not start a browser: ${err}`);
    }
    assert.ok(alive(pid), "the hidden browser runs while the run does");
    run.kill("SIGKILL");
    const quit = await gone(pid);
    if (!quit) process.kill(pid);
    assert.ok(quit, "the hidden browser is still running after its run was killed");
  });
});

test("a hidden browser an older version left on the profile is closed, and the run still starts", async t => {
  await withProfile(t, async profile => {
    let binary;
    try { binary = findBinary(); } catch { return t.skip("no browser"); }
    // The old way, as a run killed mid-way left it: hidden, detached, listening on a port, nobody connected.
    const leftover = spawn(binary, ["--remote-debugging-port=0", "--headless=new", `--user-data-dir=${profile}`,
      "--no-first-run", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore", windowsHide: true });
    const deadline = Date.now() + 20000;
    while (!existsSync(join(profile, "DevToolsActivePort")) && Date.now() < deadline) await sleep(50);
    assert.ok(existsSync(join(profile, "DevToolsActivePort")), "fixture check: the old-style browser advertises its port");
    const chrome = await Chrome.launch({ headless: true, profile });
    try {
      await chrome.goto("about:blank");
      assert.equal(await chrome.evaluate("1 + 1"), 2);
    } finally {
      await chrome.close();
    }
    assert.ok(await gone(chrome.child.pid, 3000), "the hidden browser quits on close");
    const closed = await gone(leftover.pid, 3000);
    if (!closed) leftover.kill();
    assert.ok(closed, "the leftover was closed");
  });
});
