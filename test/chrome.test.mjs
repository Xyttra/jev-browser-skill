// The browser plumbing against local fixture pages in a real headless Chrome. No network, no Jev.
// Skipped when no Chromium-based browser is installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Chrome, sleep, WAIT_MS } from "../scripts/browser.mjs";

const fixture = name => pathToFileURL(join(import.meta.dirname, "fixtures", name)).href;
const profile = mkdtempSync(join(tmpdir(), "jev-test-"));
let chrome, skip = false;

before(async () => {
  try { chrome = await Chrome.launch({ headless: true, profile }); } catch (error) { skip = `no browser: ${error.message}`; }
});
after(async () => {
  await chrome?.close();
  await sleep(300); // let Chrome release the profile before removing it
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const labels = page => page.elements.map(e => e.label);
const find = (page, label) => page.elements.find(e => e.label === label);

test("a click opens a hover-only submenu, and it stays open for the next observe", async t => {
  if (skip) return t.skip(skip);
  // Control: a press and release with no move first (the old click) never opens it.
  await chrome.goto(fixture("hover-menu.html"));
  let page = await chrome.observe();
  let point = await chrome.locate(find(page, "Enabled").node, "");
  await Promise.all(["mousePressed", "mouseReleased"].map(type =>
    chrome.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 })));
  await sleep(1000);
  page = await chrome.observe();
  assert.ok(!labels(page).includes("Downloads"), "fixture check: a click with no hover leaves the submenu shut");

  await chrome.goto(fixture("hover-menu.html"));
  page = await chrome.observe();
  point = await chrome.locate(find(page, "Enabled").node, "");
  const acted = performance.now();
  await chrome.click(point);
  await chrome.react(page, acted);
  await chrome.settle();
  const after = await chrome.observe();
  t.diagnostic(`submenu offered after hover-click: ${labels(after).includes("Downloads")}, ${Math.round(performance.now() - acted)}ms after the click`);
  assert.ok(labels(after).includes("Downloads") && labels(after).includes("Back to JQuery UI"), labels(after).join(", "));
  const parent = after.elements.find(e => e.node === find(page, "Enabled").node);
  assert.equal(parent?.label, "Enabled", "the open submenu's text is not part of its parent's label");
});

test("sortable table headers are offered as click targets, and a sort shows in their state", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("sortable-table.html"));
  const page = await chrome.observe();
  const headers = page.elements.filter(e => e.role === "columnheader");
  t.diagnostic(`headers offered: ${headers.map(e => `${e.label}${e.sort ? ` (${e.sort})` : ""}`).join(", ")}`);
  assert.deepEqual(headers.map(e => e.label), ["Last Name", "First Name", "Price"], "captions and a header holding a button are not offered");
  assert.equal(find(page, "Price").sort, "none", "aria-sort is the state");
  assert.equal(find(page, "Sort by date")?.role, "button", "the inner control is offered instead");
  assert.equal(find(page, "Last Name").op, "CLICK");
  assert.equal(find(page, "Last Name").sort, undefined, "not sorted yet");

  const acted = performance.now();
  await chrome.click(await chrome.locate(find(page, "Last Name").node, ""));
  await chrome.react(page, acted);
  const after = await chrome.observe();
  t.diagnostic(`after one click: Last Name sort=${find(after, "Last Name").sort}, react+observe ${Math.round(performance.now() - acted)}ms`);
  assert.equal(find(after, "Last Name").sort, "headerSortDown");
  assert.match(after.text, /Bach[\s\S]*Conway[\s\S]*Doe[\s\S]*Smith/, "the rows are sorted");
});

test("WAIT watches a slow page until it finishes, and gives up on a still one after 5s", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("slow-load.html"));
  let page = await chrome.observe();
  const acted = performance.now();
  await chrome.click(await chrome.locate(find(page, "Start").node, ""));
  await chrome.react(page, acted);
  page = await chrome.observe();
  assert.match(page.text, /Loading/);
  const loading = performance.now() - acted;
  const waited = await chrome.waitForChange(page);
  const after = await chrome.observe();
  t.diagnostic(`slow page: WAIT ended after ${waited}ms (result due ${Math.round(4000 - loading)}ms after the WAIT began)`);
  assert.match(after.text, /Hello World!/);
  assert.ok(waited < WAIT_MS, `ended on the change, not the cap (${waited}ms)`);

  const still = await chrome.waitForChange(after);
  t.diagnostic(`still page: WAIT ended after ${still}ms`);
  assert.ok(still >= WAIT_MS && still < WAIT_MS + 500, `${still}ms`);
});

test("a link wrapped onto two lines is aimed at its text, not the blank centre of its box", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("wrapped-link.html"));
  const centre = await chrome.evaluate(`(() => {
    const a = document.getElementById('link'), r = a.getBoundingClientRect();
    return { lines: a.getClientRects().length, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id };
  })()`);
  assert.equal(centre.lines, 2, "fixture check: the link wraps");
  assert.equal(centre.hit, "story", "fixture check: the centre of its box is the <li>");

  const page = await chrome.observe();
  const link = page.elements.find(e => e.role === "link");
  assert.ok(link, "the wrapped link is offered");
  const point = await chrome.locate(link.node, "");
  assert.equal(await chrome.evaluate(`document.elementFromPoint(${point.x}, ${point.y})?.id`), "link", "the aim point is on the link");
  await chrome.click(point, 0);
  await sleep(200);
  assert.deepEqual(await chrome.evaluate("clicks"), ["link"], "the click fired on the <a>");
  assert.equal(await chrome.evaluate("location.hash"), "#opened", "and followed it");
});

test("a see-through checkbox is offered when a click lands on it or its label, and toggles", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("see-through.html"));
  const page = await chrome.observe();
  const ids = await chrome.evaluate(`${JSON.stringify(page.elements.map(e => e.node))}.map(n => window.__jev.nodes.get(n).id)`);
  const offered = Object.fromEntries(page.elements.map((e, i) => [ids[i], e]));
  t.diagnostic(`offered: ${page.elements.map((e, i) => `${ids[i] || "-"}:${e.role} "${e.label}"`).join(", ")}`);
  assert.equal(offered.todo?.role, "checkbox", "TodoMVC toggle: the transparent input is on top");
  assert.deepEqual(["todo", "todo2", "todo3"].map(id => offered[id]?.label), ["Buy milk", "Walk the dog", "Pay rent"],
    "an unlabelled toggle takes its own row's text, never the row above's");
  assert.equal(offered.bare?.label, "Select all", "bare text after a checkbox is its caption");
  assert.equal(offered.news?.role, "checkbox", "under its label: the label takes the click");
  assert.equal(offered.news.label, "Newsletter");
  assert.ok(!offered.decoy, "transparent and covered by something else: not offered");
  assert.equal(offered.below?.label, "Agree to the terms", "below the fold: offered like any other control");

  for (const id of ["todo", "news", "below"]) {
    await chrome.click(await chrome.locate(offered[id].node, ""), 0);
    await sleep(100);
    assert.equal(await chrome.evaluate(`document.getElementById('${id}').checked`), true, `${id} is checked`);
  }
  const after = await chrome.observe();
  assert.equal(after.elements.find(e => e.node === offered.todo.node).checked, true, "Jev sees the new state");
});

test("a target under a consent pop-up is not aimed at, and the pop-up is named as what covers it", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("covered.html"));
  const node = await chrome.evaluate(`(() => { const c = window.__jev ||= { ids: new WeakMap(), nodes: new Map(), next: 1 };
    c.nodes.set(9999, document.getElementById('tech')); return 9999; })()`);
  assert.equal(await chrome.locate(node, ""), null, "covered: no aim point");
  assert.equal(await chrome.coveredBy(node), 'dialog#consent "Cookie consent"');
  await chrome.evaluate("document.getElementById('consent').remove()");
  assert.ok(await chrome.locate(node, ""), "fixture check: uncovered, it is aimed at");
  await chrome.evaluate("document.getElementById('tech').style.cssText = 'position:fixed;top:-100px'");
  assert.equal(await chrome.coveredBy(node), "off screen");
});

test("a click records where its mousedown and click landed, and whether that was the target", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("wrapped-link.html"));
  const page = await chrome.observe();
  const link = page.elements.find(e => e.role === "link");
  const landed = await chrome.click(await chrome.locate(link.node, ""), 0, link.node);
  t.diagnostic(`landed: ${JSON.stringify(landed)}`);
  assert.deepEqual(landed, { mousedown: 'a#link "A story headline long enough that it wraps onto line two"',
    click: 'a#link "A story headline long enough that it wraps onto line two"', on_target: true });

  const centre = await chrome.evaluate(`(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.getElementById('link').getBoundingClientRect())`);
  const missed = await chrome.click(centre, 0, link.node); // the old aim point: the <li>'s blank space
  assert.equal(missed.on_target, false);
  assert.match(missed.click, /^li#story/);
  assert.equal(await chrome.evaluate("window.__jevLanding"), null, "the listeners are gone");
});

/** The page's elements keyed by their DOM id. */
const byId = async page => {
  const ids = await chrome.evaluate(`${JSON.stringify(page.elements.map(e => e.node))}.map(n => window.__jev.nodes.get(n).id)`);
  return Object.fromEntries(page.elements.map((e, i) => [ids[i], e]));
};

test("a link whose text is all inside a list is named by that text, and a popup's list is left out", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("labels.html"));
  const offered = await byId(await chrome.observe());
  assert.equal(offered.plana?.label, "Plan A");
  assert.equal(offered.planb?.label, "Plan B", "not the link before it");
  assert.equal(offered.popup?.label, "Products", "a control with a popup keeps its submenu out of its name");
});

test("a checkbox whose label is what a hit test finds is offered, and a click on it toggles it", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("labels.html"));
  const offered = await byId(await chrome.observe());
  for (const [id, label] of [["remember", "Remember me"], ["terms", "Accept terms"]]) {
    assert.equal(offered[id]?.label, label, `${id} is offered`);
    const landed = await chrome.click(await chrome.locate(offered[id].node, ""), 0, offered[id].node);
    await sleep(100);
    t.diagnostic(`${id} landed: ${JSON.stringify(landed)}`);
    assert.equal(await chrome.evaluate(`document.getElementById('${id}').checked`), true, `${id} is checked`);
    assert.equal(landed.on_target, true, "a click through the control's label is on target");
  }
});
