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
