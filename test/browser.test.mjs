// Browser plumbing against fakes: the in-page autocomplete check on small fake elements, and the
// input sequence of a click on a Chrome whose DevTools connection is a recorder. No browser needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionsShown, Chrome, HOVER_MS } from "../scripts/browser.mjs";

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

test("a click leaves the pointer on the target, so a submenu it opened stays open", async () => {
  const { chrome, sent } = recorder();
  await chrome.click({ x: 5, y: 5 }, 0);
  assert.ok(!sent.some(e => e.type === "mouseMoved" && e.x < 0), "no park after the click");
});
