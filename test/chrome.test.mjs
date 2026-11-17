// The browser plumbing against local fixture pages in a real headless Chrome. No network, no Jev.
// Skipped when no Chromium-based browser is installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Chrome, sleep, WAIT_MS, LOAD_MS } from "../scripts/browser.mjs";

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
  for (const label of ["Notes", "Tags", "Owner", "Clickable rows", "Row A", "Row B"]) {
    assert.ok(!find(page, label), `${label}: a "no sort" class, an inherited cursor or a row header is not a sortable header`);
  }
  assert.ok(!find(page, "Select") || find(page, "Select").role === "checkbox", "a header holding a checkbox is not offered");
  assert.equal(find(page, "Select")?.role, "checkbox", "its checkbox is, with the header's text");
  assert.equal(find(page, "Last Name").op, "CLICK");
  assert.equal(find(page, "Last Name").sort, "unsorted", "not sorted yet");

  const acted = performance.now();
  await chrome.click(await chrome.locate(find(page, "Last Name").node, ""));
  await chrome.react(page, acted);
  const after = await chrome.observe();
  t.diagnostic(`after one click: Last Name sort=${find(after, "Last Name").sort}, react+observe ${Math.round(performance.now() - acted)}ms`);
  assert.equal(find(after, "Last Name").sort, "sorted", "tablesorter 2.0 marks this ascending sort headerSortDown: the direction is left to the rows");
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
  await chrome.click(await chrome.locate(link.node, ""), 0, link.node);
  const landed = await chrome.landed();
  t.diagnostic(`landed: ${JSON.stringify(landed)}`);
  assert.deepEqual(landed, { mousedown: 'a#link "A story headline long enough that it wraps onto line two"',
    click: 'a#link "A story headline long enough that it wraps onto line two"', on_target: true });

  const centre = await chrome.evaluate(`(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.getElementById('link').getBoundingClientRect())`);
  // A point that does not belong to the target (the old aim point, the <li>'s blank space) is
  // never pressed: the check before the press moves it onto the link.
  await chrome.click(centre, 0, link.node);
  const moved = await chrome.landed();
  assert.equal(moved.on_target, true);
  assert.match(moved.click, /^a#link/);
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
    await chrome.click(await chrome.locate(offered[id].node, ""), 0, offered[id].node);
    const landed = await chrome.landed();
    await sleep(100);
    t.diagnostic(`${id} landed: ${JSON.stringify(landed)}`);
    assert.equal(await chrome.evaluate(`document.getElementById('${id}').checked`), true, `${id} is checked`);
    assert.equal(landed.on_target, true, "a click through the control's label is on target");
  }
});

test("a hover pop-up that covers the target before the press takes no click", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("hover-overlay.html"));
  const offered = await byId(await chrome.observe());
  const story = await chrome.evaluate("document.getElementById('story').getClientRects().length");
  assert.equal(story, 2, "fixture check: the story link wraps");

  const point = await chrome.locate(offered.add.node, "");
  const pressed = await chrome.click(point, undefined, offered.add.node);
  await sleep(100);
  t.diagnostic(`whole target covered: click returned ${JSON.stringify(pressed)}, clicks ${await chrome.evaluate("JSON.stringify(log)")}`);
  assert.deepEqual(await chrome.evaluate("log"), [], "Quick view, now under the pointer, is not clicked");
  assert.equal(pressed, false, "the click reports that it did not press");

  await chrome.evaluate("log.length = 0");
  const line1 = await chrome.locate(offered.story.node, "");
  await chrome.click(line1, undefined, offered.story.node);
  await sleep(100);
  t.diagnostic(`first line covered: clicks ${await chrome.evaluate("JSON.stringify(log)")}`);
  assert.deepEqual(await chrome.evaluate("log"), ["story"], "pressed on the link's other line instead");
});

/** Serves slow-fetch.html, and answers /results after ?delay= ms (never, for ?delay=never). */
async function slowServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/results") return response.end(readFileSync(join(import.meta.dirname, "fixtures", "slow-fetch.html")));
    const delay = url.searchParams.get("delay");
    if (delay !== "never") setTimeout(() => response.end("<h2>7 trade marks found</h2>"), Number(delay));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: delay => `http://127.0.0.1:${server.address().port}/?delay=${delay}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

/** Opens the search page, clicks Search, and observes the page as the loop would. */
async function search(url, { awaitLoad = true, limit } = {}) {
  await chrome.goto(url);
  const page = await chrome.observe();
  const acted = performance.now();
  await chrome.click(await chrome.locate(find(page, "Search").node, ""));
  await chrome.react(page, acted);
  await chrome.settle();
  const load = awaitLoad ? await chrome.awaitLoad(acted, limit ? { limit } : undefined) : null;
  return { load, page: await chrome.observe(), ms: Math.round(performance.now() - acted) };
}

test("a click whose results come from a slow request is observed after they arrive, not on the empty shell", async t => {
  if (skip) return t.skip(skip);
  const server = await slowServer();
  try {
    const control = await search(server.url(2500), { awaitLoad: false });
    t.diagnostic(`without the load wait: observed after ${control.ms}ms, text ${JSON.stringify(control.page.text)}`);
    assert.doesNotMatch(control.page.text, /trade marks found/, "fixture check: the page looks settled before its results arrive");

    const fixed = await search(server.url(2500));
    t.diagnostic(`with the load wait: ${JSON.stringify(fixed.load)}, observed after ${fixed.ms}ms`);
    assert.match(fixed.page.text, /7 trade marks found/);
    assert.equal(fixed.load.pending, 0);
    assert.ok(fixed.load.waited_ms < LOAD_MS, `ended when the request finished (${fixed.load.waited_ms}ms)`);
  } finally { server.close(); }
});

test("a request that never answers ends the load wait at its limit", async t => {
  if (skip) return t.skip(skip);
  const server = await slowServer();
  try {
    const stuck = await search(server.url("never"), { limit: 2000 });
    t.diagnostic(`never-answering request: ${JSON.stringify(stuck.load)}`);
    assert.equal(stuck.load.pending, 1);
    assert.ok(stuck.load.waited_ms >= 2000 && stuck.load.waited_ms < 2600, `${stuck.load.waited_ms}ms`);
  } finally { server.close(); }
});

test("controls and text inside open shadow roots are offered, and a pop-up's field there is typed into", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("shadow.html"));
  let page = await chrome.observe();
  t.diagnostic(`offered: ${labels(page).join(", ")}`);
  assert.ok(page.text.includes("Find a book"), "text inside a shadow root is page text");
  assert.equal(find(page, "Search books")?.op, "TYPE", "a field two shadow roots deep, named by aria-labelledby in its own root");
  assert.equal(find(page, "Search books").search, true, "inside a role=search form");
  assert.ok(find(page, "Go"), "its submit button");
  assert.ok(!labels(page).includes("Hidden button"), "a control under an aria-hidden host is not offered");
  assert.ok(await chrome.locate(find(page, "Go").node, ""), "a shadow control is aimed at: the hit test sees into its root");

  await chrome.evaluate("openOverlay()");
  page = await chrome.observe();
  assert.ok(!find(page, "Home"), "the light-DOM link the pop-up covers is not offered");
  const field = find(page, "Search everything");
  assert.equal(field?.op, "TYPE", "the pop-up's field, in a shadow root, is offered");
  await chrome.click(await chrome.locate(field.node, ""), 0, field.node);
  await chrome.type(field.node, "Aldus Manutius");
  assert.equal(await chrome.evaluate("document.querySelector('x-overlay').shadowRoot.getElementById('pq').value"), "Aldus Manutius");
});

test("a consent banner's accept-all controls are withheld; its reject controls and ordinary Accept, OK and I agree are offered", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("consent.html"));
  const page = await chrome.observe();
  t.diagnostic(`offered: ${labels(page).join(", ")}; consent: ${JSON.stringify(page.consent)}`);
  for (const label of ["Accept all", "Alle akzeptieren"]) assert.ok(!find(page, label), `${label} is not offered`);
  for (const label of ["Reject all", "Settings", "Nur notwendige", "Accept", "OK", "I agree", "Cookie settings"]) assert.ok(find(page, label), `${label} is offered`);
  assert.deepEqual(page.consent.withheld.sort(), ["Accept all", "Alle akzeptieren"]);
  assert.deepEqual(page.consent.offered.sort(), ["Nur notwendige", "Reject all", "Settings"]);
  assert.equal(page.consent.blocking, false);
});

test("a cookie banner after the first 250 controls is still seen: its accept withheld, its other controls offered", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("consent-crowded.html"));
  const page = await chrome.observe();
  assert.ok(page.elements.length <= 250 && page.omitted > 0, `the limit still holds (${page.elements.length} offered, ${page.omitted} omitted)`);
  assert.ok(find(page, "Only necessary"), "the banner's decline is offered");
  assert.ok(!find(page, "Accept all"), "the banner's accept is not");
  assert.deepEqual(page.consent.withheld, ["Accept all"]);
  assert.deepEqual(page.consent.offered, ["Only necessary"]);
  assert.ok(find(page, "Article 1"), "the page's own controls come first");
});

test("a consent wall whose only way past is accepting offers nothing to click and says so", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("consent-wall.html"));
  const page = await chrome.observe();
  assert.deepEqual(labels(page), [], "the accept button is withheld and the link under the wall is covered");
  assert.deepEqual(page.consent, { withheld: ["Accept and continue"], offered: [], frames: [], blocking: true });
});

test("a banner is in the way when it covers the middle of the screen, not when it is a bar at the edge", async t => {
  if (skip) return t.skip(skip);
  await chrome.goto(fixture("consent-modal.html"));
  let page = await chrome.observe();
  assert.deepEqual(labels(page), ["No, rather not"], "the link under the overlay is covered and Accept is withheld");
  assert.equal(page.consent.blocking, true);
  await chrome.goto(fixture("consent.html"));
  page = await chrome.observe();
  assert.equal(page.consent.blocking, false, "a bar at the bottom");
});
