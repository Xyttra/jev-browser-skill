// The browser plumbing against local fixture pages in a real headless Chrome. No network, no Jev.
// Skipped when no Chromium-based browser is installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Chrome, sleep } from "../scripts/browser.mjs";

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
});
