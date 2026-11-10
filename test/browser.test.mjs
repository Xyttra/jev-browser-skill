// Browser plumbing against fakes: the in-page autocomplete check on small fake elements, and the
// input sequence of a click on a Chrome whose DevTools connection is a recorder. No browser needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionsShown, Chrome, HOVER_MS, WAIT_MS, SCREENSHOT_MS, LANDING_MS } from "../scripts/browser.mjs";

/** A Chrome whose every DevTools command is recorded with the time it was sent. */
const recorder = () => {
  const chrome = new Chrome({ owned: true }), sent = [];
  chrome.send = async (method, params = {}) => { sent.push({ method, ...params, at: performance.now() }); return {}; };
  return { chrome, sent };
};

const field = attributes => ({ getAttribute: name => attributes[name] ?? null });
const option = visible => ({ checkVisibility: () => visible });
const list = options => ({ querySelectorAll: selector => (selector === '[role="option"]' ? options : []) });
const page = (lists = {}, everywhere = []) => ({ getElementById: id => lists[id] ?? null, ...list(everywhere) });

test("a plain textbox gets no suggestion wait", () => {
  assert.equal(suggestionsShown(field({ type: "text" }), page({}, [option(true)])), null);
  assert.equal(suggestionsShown(undefined, page()), null, "a node that is gone");
});

test("each autocomplete hint makes the field wait for suggestions", () => {
  for (const attributes of [{ role: "combobox" }, { role: "searchbox" }, { "aria-autocomplete": "list" },
    { "aria-controls": "x" }, { "aria-owns": "x" }, { list: "x" }]) {
    assert.equal(suggestionsShown(field(attributes), page()), false, JSON.stringify(attributes));
  }
});

test("a field naming its list counts only visible options inside that list", () => {
  const box = field({ role: "combobox", "aria-controls": "menu" });
  assert.equal(suggestionsShown(box, page({ menu: list([]) }, [option(true)])), false, "options elsewhere do not count");
  assert.equal(suggestionsShown(box, page({ menu: list([option(false)]) })), false, "a hidden option does not count");
  assert.equal(suggestionsShown(box, page({ menu: list([option(true)]) })), true);
  const owns = field({ "aria-owns": "a b" });
  assert.equal(suggestionsShown(owns, page({ b: list([option(true)]) })), true, "any of several named lists");
});

test("a hinted field naming no list counts visible options anywhere on the page", () => {
  assert.equal(suggestionsShown(field({ role: "searchbox" }), page({}, [option(true)])), true);
  assert.equal(suggestionsShown(field({ list: "cities" }), page({}, [option(false)])), false);
});

test("a click hovers the target first, rests, then presses and releases there", async () => {
  const { chrome, sent } = recorder();
  await chrome.click({ x: 40, y: 70 });
  assert.deepEqual(sent.map(e => [e.type, e.x, e.y]), [["mouseMoved", 40, 70], ["mousePressed", 40, 70], ["mouseReleased", 40, 70]]);
  assert.ok(sent[1].at - sent[0].at >= HOVER_MS - 5, `hover handlers get ${HOVER_MS}ms before the press`);
  assert.ok(HOVER_MS >= 100 && HOVER_MS <= 150);
});

/** A recorder whose page answers the pre-press check with `reaim` (ARM/READ_LANDING answer true). */
const rechecking = reaim => {
  const { chrome, sent } = recorder();
  chrome.evaluate = async expression => (expression.includes("elementFromPoint(x, y)") ? reaim : true);
  return { chrome, sent };
};

test("after the hover beat the point is checked again: pressed there, at another point of the target, or not at all", async () => {
  let { chrome, sent } = rechecking({ x: 40, y: 70 });
  await chrome.click({ x: 40, y: 70 }, 0, 7);
  assert.deepEqual(sent.map(e => [e.type, e.x, e.y]), [["mouseMoved", 40, 70], ["mousePressed", 40, 70], ["mouseReleased", 40, 70]]);

  ({ chrome, sent } = rechecking({ x: 40, y: 90 }));
  await chrome.click({ x: 40, y: 70 }, 0, 7);
  assert.deepEqual(sent.map(e => [e.type, e.x, e.y]), [["mouseMoved", 40, 70], ["mouseMoved", 40, 90], ["mousePressed", 40, 90], ["mouseReleased", 40, 90]],
    "the hover covered that point: the press moves to one that is still the target's");

  for (const reaim of [null, undefined]) {
    ({ chrome, sent } = rechecking(reaim));
    assert.equal(await chrome.click({ x: 40, y: 70 }, 0, 7), false, "nothing of the target is left under any point");
    assert.ok(!sent.some(e => e.type === "mousePressed"), `never pressed (${reaim})`);
  }
});

test("a click does not read where it landed: that waits until after the reaction, for at most 1s", async () => {
  const { chrome } = recorder(), reads = [];
  chrome.evaluate = async (expression, timeout) => { reads.push({ expression, timeout }); return expression.includes("elementFromPoint(x, y)") ? { x: 1, y: 1 } : true; };
  assert.equal(await chrome.click({ x: 1, y: 1 }, 0, 7), true, "pressed");
  assert.ok(!reads.some(r => r.expression.includes("__jevLanding = null")), "the landing is not read inside the click");
  chrome.evaluate = async (expression, timeout) => { reads.push({ expression, timeout }); return { on_target: true }; };
  assert.deepEqual(await chrome.landed(), { on_target: true });
  assert.equal(reads.at(-1).timeout, LANDING_MS);
  assert.equal(LANDING_MS, 1000);
  chrome.evaluate = async () => undefined; // the page did not answer in time
  assert.equal(await chrome.landed(), null);
});

test("a click leaves the pointer on the target, so a submenu it opened stays open", async () => {
  const { chrome, sent } = recorder();
  await chrome.click({ x: 5, y: 5 }, 0);
  assert.ok(!sent.some(e => e.type === "mouseMoved" && e.x < 0), "no park after the click");
});

/** A Chrome whose page reads come from `reads` in turn (the last repeats), counting each read. */
const scripted = reads => {
  const chrome = new Chrome({ owned: true });
  chrome.reads = 0;
  chrome.evaluate = async () => reads[Math.min(chrome.reads++, reads.length - 1)];
  return chrome;
};
const shown = text => ({ url: "https://example.com/", text, elements: [] });

test("WAIT ends as soon as the page changes", async () => {
  const chrome = scripted([shown("Loading..."), shown("Loading..."), shown("Hello World!")]);
  const waited = await chrome.waitForChange(shown("Loading..."), { every: 10 });
  assert.equal(chrome.reads, 3, "stopped at the first changed read");
  assert.ok(waited < 200, `${waited}ms`);
});

test("WAIT gives up after its limit when nothing changes, and a page mid-navigation is not a change", async () => {
  const chrome = scripted([undefined, shown("Loading...")]);
  const waited = await chrome.waitForChange(shown("Loading..."), { limit: 120, every: 20 });
  assert.ok(waited >= 120 && waited < 250, `${waited}ms`);
  assert.ok(chrome.reads >= 4, "kept polling");
  assert.equal(WAIT_MS, 5000, "three unchanged WAITs then allow about 15s before the run stops");
});

test("a screenshot gives up after 5s, not the 20s every other command gets", async () => {
  const chrome = new Chrome({ owned: true });
  let waited;
  chrome.send = async (method, params, session, timeout) => { waited = timeout; return { data: "AAAA" }; };
  assert.equal(await chrome.screenshot(), "data:image/jpeg;base64,AAAA");
  assert.equal(waited, SCREENSHOT_MS);
  assert.equal(SCREENSHOT_MS, 5000);
  await chrome.screenshot("png");
  assert.equal(waited, SCREENSHOT_MS, "the final --screenshot file too");
});

test("a trace screenshot that hangs is recorded as missing and the run carries on", async () => {
  const chrome = new Chrome({ owned: true });
  chrome.session = "s";
  chrome.socket = { send() {} }; // the page never answers
  const shot = await chrome.traceScreenshot(50);
  assert.equal(shot.screenshot, null);
  assert.match(shot.screenshot_error, /Page\.captureScreenshot got no reply/);
  assert.equal(chrome.pending.size, 0, "no reply is left waiting");
});
