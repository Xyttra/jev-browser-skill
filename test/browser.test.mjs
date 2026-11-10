// The in-page autocomplete check, run against small fake elements. No browser needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionsShown } from "../scripts/browser.mjs";

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
