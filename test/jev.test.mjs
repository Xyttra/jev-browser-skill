// The loop in jev.mjs against a stub browser and a stub decide(): when it stops, why, and what
// the summary and the trace record. No browser and no Jev API needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../scripts/jev.mjs";
import { TARGET_GONE, TARGET_HIDDEN } from "../scripts/core.mjs";

const button = { index: 1, node: 7, role: "button", label: "Buy" };
const page = { url: "https://shop.test/", title: "Shop", text: "A shop", elements: [button] };

/** A browser whose page never changes. `overrides` replace single methods. */
const stubChrome = (overrides = {}) => ({
  goto: async () => {}, observe: async () => page, traceScreenshot: async () => ({ screenshot: null }),
  locate: async () => ({ x: 10, y: 10 }), park: async () => {}, settle: async () => {},
  coveredBy: async () => 'dialog "Cookie consent"', click: async () => true, select: async () => {},
  type: async () => {}, awaitSuggestions: async () => {}, enter: async () => {},
  waitForChange: async () => 1234, react: async () => {}, landed: async () => null,
  awaitLoad: async () => ({ waited_ms: 0, pending: 0 }),
  screenshot: async () => Buffer.from("png"), ...overrides,
});

const decision = (operation, { e, operation_p = 0.9, goal_met = 0.1, stuck = 0.1 } = {}) => ({
  operation, e, p: operation_p, operation_p, checks: { goal_met, stuck }, ms: 100, calls: [],
  probabilities: { operation: { [operation]: operation_p } },
});
const click = extra => decision("CLICK", { e: button, ...extra });

/** Runs the loop with `decisions` answered in order (the last one repeats). */
async function loop(decisions, { chrome = stubChrome(), ...options } = {}) {
  const files = {}, lines = [];
  let i = 0;
  const result = await run({
    chrome, ask: null, decide: async () => decisions[Math.min(i++, decisions.length - 1)],
    goal: "buy it", texts: [], url: page.url, model: "jev-test", maxSteps: 20, headless: true,
    trace: "trace.json", write: (path, data) => { files[path] = data; }, log: line => lines.push(line), ...options,
  });
  return { result, trace: files["trace.json"] && JSON.parse(files["trace.json"]), files, lines };
}

test("three steps that change nothing stop the run as no_progress", async () => {
  const { result } = await loop([click()]);
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked_reason, "no_progress");
  assert.equal(result.steps, 3);
});

test("a BLOCKED answer stops the run as jev_blocked", async () => {
  const { result, trace } = await loop([decision("BLOCKED")]);
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked_reason, "jev_blocked");
  assert.equal(trace.steps[0].blocked_reason, "jev_blocked");
});

test("three skips in a row stop the run as covered and name what was on top", async () => {
  const { result, trace } = await loop([click()], { chrome: stubChrome({ locate: async () => null }) });
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked_reason, "covered");
  assert.equal(result.covered_by, 'dialog "Cookie consent"');
  assert.equal(trace.steps.length, 3);
  assert.ok(trace.steps.every(s => s.executed === false));
});

test("a WAIT step records how long it waited", async () => {
  const { result, trace } = await loop([decision("WAIT"), decision("DONE", { goal_met: 0.9 })]);
  assert.equal(result.status, "done");
  assert.equal(trace.steps[0].waited_ms, 1234);
  assert.equal(trace.steps[0].executed, true);
});

test("an unsure step does nothing and hands back the proposal", async () => {
  let clicked = false;
  const chrome = stubChrome({ click: async () => (clicked = true) });
  const { result } = await loop([click({ operation_p: 0.4 })], { chrome });
  assert.equal(result.status, "unsure");
  assert.equal(result.unsure.proposed, 'CLICK button "Buy"');
  assert.equal(result.unsure.operation_p, 0.4);
  assert.equal(clicked, false);
});

test("three skips in a row whose last target is gone or hidden stop the run as target_gone", async () => {
  for (const cover of [TARGET_GONE, TARGET_HIDDEN]) {
    const chrome = stubChrome({ locate: async () => null, coveredBy: async () => cover });
    const { result, trace } = await loop([click()], { chrome });
    assert.equal(result.status, "blocked");
    assert.equal(result.blocked_reason, "target_gone", cover);
    assert.equal(trace.steps.at(-1).blocked_reason, "target_gone");
    assert.equal(result.covered_by, cover, "the summary still says what was found");
  }
});

test("the final screenshot gets 20s, and is written to the --screenshot file", async () => {
  let args;
  const chrome = stubChrome({ screenshot: async (...a) => { args = a; return Buffer.from("png"); } });
  const { result, files } = await loop([decision("DONE", { goal_met: 0.9 })], { chrome, screenshot: "out.png" });
  assert.deepEqual(args, ["png", 20000]);
  assert.equal(String(files["out.png"]), "png");
  assert.equal(result.screenshot, "out.png");
  assert.equal(result.screenshot_error, undefined);
});

test("a final screenshot that fails still yields the summary and the trace, with screenshot_error", async () => {
  const chrome = stubChrome({ screenshot: async () => { throw new Error("Page.captureScreenshot got no reply"); } });
  const { result, trace, files, lines } = await loop([decision("DONE", { goal_met: 0.9 })], { chrome, screenshot: "out.png" });
  assert.equal(result.status, "done", "the run's own status stands");
  assert.match(result.screenshot_error, /Page\.captureScreenshot got no reply/);
  assert.equal(result.screenshot, undefined, "no file was saved");
  assert.equal(files["out.png"], undefined);
  assert.equal(trace.steps.length, 1, "the trace is written");
  assert.deepEqual(trace.result, result);
  assert.match(lines.at(-1), /"screenshot_error"/, "the summary is printed");
});

test("after an action the loop waits for the page to load, from the moment it acted, and the trace records it", async () => {
  const calls = [];
  const chrome = stubChrome({ awaitLoad: async since => { calls.push(since); return { waited_ms: 2100, pending: 0 }; } });
  const { trace } = await loop([click(), decision("DONE", { goal_met: 0.95 })], { chrome });
  assert.equal(calls.length, 1, "once, after the click");
  assert.ok(typeof calls[0] === "number" && calls[0] > 0, "from the time of the click");
  assert.deepEqual(trace.steps[0].load, { waited_ms: 2100, pending: 0 });
});

test("a WAIT step, which acts on nothing, has no load wait of its own", async () => {
  const calls = [];
  const chrome = stubChrome({ awaitLoad: async since => { calls.push(since); return { waited_ms: 0, pending: 0 }; } });
  await loop([decision("WAIT"), decision("DONE", { goal_met: 0.95 })], { chrome });
  assert.equal(calls.length, 0);
});

/**
 * A browser whose page changes only when the loop rechecks before giving up: each quiet
 * awaitLoad moves to the next of `pages` (the last one stays). Records every awaitLoad call.
 */
const loadingChrome = (pages, { waited_ms = 1500 } = {}) => {
  const loads = [];
  let at = 0;
  const chrome = stubChrome({
    observe: async () => pages[at],
    awaitLoad: async (since, options = {}) => {
      loads.push({ since, ...options });
      if (!options.quiet) return { waited_ms: 0, pending: 0 };
      at = Math.min(at + 1, pages.length - 1);
      return { waited_ms, pending: 0 };
    },
  });
  return { chrome, loads, rechecks: () => loads.filter(l => l.quiet) };
};
const later = (text, extra = {}) => ({ ...page, text, ...extra });
/** decide() by page text: `answers[text]` is the decision on that page. */
const byPage = answers => async (ask, { page: seen }) => answers[seen.text];

test("an unsure step on a page still loading looks again, and Jev decides on the new page", async () => {
  const { chrome, rechecks } = loadingChrome([page, later("Results")]);
  const decide = byPage({ "A shop": click({ operation_p: 0.4 }), Results: decision("DONE", { goal_met: 0.95 }) });
  const { result, trace, lines } = await loop([], { chrome, decide });
  assert.equal(result.status, "done");
  assert.equal(result.steps, 0, "the unsure step pushed no history");
  assert.equal(rechecks().length, 1);
  assert.equal(rechecks()[0].limit, 10000);
  assert.deepEqual(trace.steps[0].recheck, { waited_ms: 1500, page_changed: true });
  assert.equal(trace.steps[0].executed, false);
  assert.equal(trace.steps.length, 2, "the new page is a new trace step");
  assert.ok(lines.some(l => /recheck: still loading, waited 1\.5s, page changed; asking Jev again/.test(l)));
});

test("an unsure step whose page does not change on the recheck stops as before, after one recheck", async () => {
  const { chrome, rechecks } = loadingChrome([page]);
  const { result, trace } = await loop([click({ operation_p: 0.4 })], { chrome });
  assert.equal(result.status, "unsure");
  assert.equal(rechecks().length, 1);
  assert.deepEqual(trace.steps[0].recheck, { waited_ms: 1500, page_changed: false });
});

test("a blocked answer is rechecked like an unsure one", async () => {
  const { chrome, rechecks } = loadingChrome([page, later("Results")]);
  const decide = byPage({ "A shop": decision("BLOCKED"), Results: decision("DONE", { goal_met: 0.95 }) });
  const { result, trace } = await loop([], { chrome, decide });
  assert.equal(result.status, "done");
  assert.equal(rechecks().length, 1);
  assert.equal(trace.steps[0].blocked_reason, undefined);
});

test("the 10s recheck budget is shared by the rechecks of one step and starts again after an action", async () => {
  const pages = ["A", "B", "C", "D"].map(t => later(t));
  const { chrome, rechecks } = loadingChrome(pages, { waited_ms: 4000 });
  const unsure = click({ operation_p: 0.4 });
  const acted = [];
  const decide = async (ask, { page: seen }) => {
    if (seen.text !== "D" || acted.length) return unsure;
    acted.push(performance.now());
    return click();
  };
  const { result, trace } = await loop([], { chrome, decide });
  assert.deepEqual(rechecks().map(l => l.limit), [10000, 6000, 2000, 10000]);
  assert.ok(rechecks().every(l => l.quiet === true));
  const [first, , , afterClick] = rechecks();
  assert.ok(afterClick.since > first.since, "after the click it waits for what the click started");
  assert.equal(result.status, "unsure");
  assert.deepEqual(trace.steps.at(-1).recheck, { waited_ms: 4000, page_changed: false });
});

test("with the budget spent the loop stops without waiting again", async () => {
  const pages = ["A", "B", "C", "D"].map(t => later(t));
  const { chrome, rechecks } = loadingChrome(pages, { waited_ms: 6000 });
  const { result, trace } = await loop([click({ operation_p: 0.4 })], { chrome });
  assert.deepEqual(rechecks().map(l => l.limit), [10000, 4000], "a third recheck has nothing left");
  assert.equal(result.status, "unsure");
  assert.deepEqual(trace.steps.at(-1).recheck, { waited_ms: 0, page_changed: false });
});

test("the no_progress stop is rechecked too: a page that changed carries on", async () => {
  const { chrome, rechecks } = loadingChrome([page, later("Results")]);
  const decide = byPage({ "A shop": click(), Results: decision("DONE", { goal_met: 0.95 }) });
  const { result, trace } = await loop([], { chrome, decide });
  assert.equal(result.status, "done");
  assert.equal(result.steps, 3);
  assert.equal(rechecks().length, 1);
  assert.deepEqual(trace.steps[2].recheck, { waited_ms: 1500, page_changed: true });
});

test("the no_progress stop with an unchanged page still stops, after one recheck", async () => {
  const { chrome, rechecks } = loadingChrome([page]);
  const { result, trace } = await loop([click()], { chrome });
  assert.equal(result.blocked_reason, "no_progress");
  assert.equal(rechecks().length, 1);
  assert.deepEqual(trace.steps[2].recheck, { waited_ms: 1500, page_changed: false });
});

test("the wait after an action does not ask for quiet time", async () => {
  const { chrome, loads } = loadingChrome([page]);
  await loop([click(), decision("DONE", { goal_met: 0.95 })], { chrome });
  assert.equal(loads.length, 1);
  assert.equal(loads[0].quiet, undefined);
});

const walled = (consent, elements = [button]) => ({ ...page, elements, consent });

test("a stop while a cookie banner can only be accepted is blocked as cookie_consent, whatever stopped it", async () => {
  const only = { withheld: ["Accept all"], offered: [], frames: [] };
  for (const [decisions, chrome] of [
    [[decision("BLOCKED")], stubChrome({ observe: async () => walled(only, []) })],
    [[decision("WAIT")], stubChrome({ observe: async () => walled(only, []) })],
    [[click()], stubChrome({ observe: async () => walled(only), locate: async () => null })],
  ]) {
    const { result, lines } = await loop(decisions, { chrome });
    assert.equal(result.status, "blocked");
    assert.equal(result.blocked_reason, "cookie_consent", decisions[0].operation);
    assert.ok(lines.some(l => /cookie banner/.test(l)), "the log says why");
  }
});

test("a banner that can be rejected, or no banner, keeps the ordinary blocked reason", async () => {
  const rejectable = { withheld: ["Accept all"], offered: ["Reject all"], frames: [] };
  let { result } = await loop([decision("BLOCKED")], { chrome: stubChrome({ observe: async () => walled(rejectable) }) });
  assert.equal(result.blocked_reason, "jev_blocked");
  ({ result } = await loop([decision("BLOCKED")]));
  assert.equal(result.blocked_reason, "jev_blocked", "a page with no consent field");
});

test("covered by a consent frame the snapshot cannot read is cookie_consent; other stops beside it are not", async () => {
  const framed = { withheld: [], offered: [], frames: ['iframe#sp_message_iframe "Consent"'] };
  let { result } = await loop([click()], { chrome: stubChrome({ observe: async () => walled(framed), locate: async () => null }) });
  assert.equal(result.blocked_reason, "cookie_consent");
  ({ result } = await loop([decision("BLOCKED")], { chrome: stubChrome({ observe: async () => walled(framed) }) }));
  assert.equal(result.blocked_reason, "jev_blocked");
});
