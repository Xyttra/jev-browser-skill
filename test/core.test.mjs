// Pure-logic tests for the decision layer. No network, no browser, no dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, readDecision, verdict, blockReason, fingerprint, sortableHeader, sortState, CHECKS, OPERATIONS } from "../scripts/core.mjs";

// A page shaped like a login form: a text field, a password field, a button, a link.
const loginPage = () => ({
  url: "https://example.com/login", title: "Login", text: "Login",
  elements: [
    { node: 1, role: "textbox", label: "username:", value: "", op: "TYPE" },
    { node: 2, role: "password", label: "password:", value: "", op: "SECRET" },
    { node: 3, role: "button", label: "log in", op: "CLICK" },
    { node: 4, role: "link", label: "Forgot?", op: "CLICK" },
  ],
});
const withDropdown = () => ({
  ...loginPage(),
  elements: [
    { node: 5, role: "dropdown", label: "Language", value: "English", op: "SELECT",
      options: [{ value: "ca", label: "Català" }, { value: "de", label: "Deutsch" }] },
  ],
});
const base = { goal: "log in", texts: ["ada"], secret: "hunter2", history: [] };

test("elements are indexed from 1 and the indices are the answer keys", () => {
  const { body, targets } = buildRequest({ ...base, page: loginPage() });
  assert.deepEqual(body.state.elements.map(e => e.index), ["1", "2", "3", "4"]);
  assert.deepEqual(Object.keys(targets.CLICK), ["1", "3", "4"]);
});

test("only operations the page supports are offered", () => {
  const { offered } = buildRequest({ ...base, page: loginPage() });
  assert.ok(!("SELECT" in offered), "no dropdown on the page, so no SELECT");
  assert.ok(!("ENTER" in offered), "nothing was typed yet, so no ENTER");
  assert.ok(["CLICK", "TYPE", "DONE", "BLOCKED"].every(op => op in offered));
});

test("ENTER is offered only straight after a TYPE", () => {
  const after = op => buildRequest({ ...base, page: loginPage(), history: [{ operation: op }] }).offered;
  assert.ok("ENTER" in after("TYPE"));
  assert.ok(!("ENTER" in after("CLICK")));
});

test("a click tried twice on the same URL is not offered again", () => {
  const click = (url = "https://example.com/login") => ({ operation: "CLICK", target: 'link "Forgot?"', url });
  const offeredClicks = history => Object.keys(buildRequest({ ...base, page: loginPage(), history }).targets.CLICK);
  assert.ok(offeredClicks([click()]).includes("4"), "one try is not a loop");
  assert.ok(!offeredClicks([click(), click()]).includes("4"));
  assert.ok(offeredClicks([click(), click("https://example.com/other")]).includes("4"), "tries elsewhere do not count");
});

test("each target head holds only elements that operation can act on", () => {
  const { targets } = buildRequest({ ...base, page: loginPage() });
  // a text field is clickable too: clicking focuses it or opens its autocomplete
  assert.deepEqual(Object.keys(targets.CLICK).sort(), ["1", "3", "4"]);
  assert.deepEqual(Object.keys(targets.TYPE).sort(), ["1", "2"], "editable fields only");
  assert.ok(!("2" in targets.CLICK), "a password field is never a click target");
});

test("a dropdown expands to one choice per option, keyed element:option", () => {
  const { targets, offered } = buildRequest({ ...base, page: withDropdown() });
  assert.ok("SELECT" in offered);
  assert.deepEqual(Object.keys(targets.SELECT), ["1:1", "1:2"]);
  assert.equal(targets.SELECT["1:1"].option.label, "Català");
});

test("the secret never appears anywhere in the request", () => {
  const { body } = buildRequest({ ...base, page: loginPage(), secret: "hunter2" });
  assert.ok(!JSON.stringify(body).includes("hunter2"), "a password must never be sent to Jev");
});

test("a password field is only a TYPE target when a secret was supplied", () => {
  const withSecret = buildRequest({ ...base, page: loginPage(), secret: "hunter2" });
  const without = buildRequest({ ...base, page: loginPage(), secret: "" });
  assert.ok("2" in withSecret.targets.TYPE);
  assert.ok(!("2" in without.targets.TYPE));
});

test("no text values means TYPE is not offered at all", () => {
  const { offered } = buildRequest({ ...base, page: loginPage(), texts: [], secret: "" });
  assert.ok(!("TYPE" in offered));
});

test("with nothing to type, a text field is not a click target either", () => {
  const { targets } = buildRequest({ ...base, page: loginPage(), texts: [] });
  assert.deepEqual(Object.keys(targets.CLICK), ["3", "4"]);
});

test("with nothing to type, a search form's button is not offered", () => {
  const page = loginPage();
  page.elements[2].search = true;
  assert.ok(!("3" in buildRequest({ ...base, page, texts: [] }).targets.CLICK));
  assert.ok("3" in buildRequest({ ...base, page }).targets.CLICK, "with text it submits a real query");
});

test("a link back to a page already visited is not offered", () => {
  const page = loginPage();
  page.elements[3].href = "https://example.com/home";
  const history = [{ operation: "CLICK", target: 'link "Login"', url: "https://example.com/home#top" }];
  assert.ok(!("4" in buildRequest({ ...base, page, history }).targets.CLICK));
  assert.ok("4" in buildRequest({ ...base, page }).targets.CLICK);
  const redirected = [{ operation: "CLICK", target: 'link "Home"', url: "https://example.com/x", href: "https://example.com/home" }];
  assert.ok(!("4" in buildRequest({ ...base, page, history: redirected }).targets.CLICK), "a clicked href counts even if it redirected");
});

test("repeat clicks count across #hash changes, where apps keep view state", () => {
  const page = { ...loginPage(), url: "https://example.com/login#b" };
  const click = hash => ({ operation: "CLICK", target: 'link "Forgot?"', url: `https://example.com/login#${hash}` });
  assert.ok(!("4" in buildRequest({ ...base, page, history: [click("a"), click("b")] }).targets.CLICK));
});

test("internal hints never reach Jev", () => {
  const page = loginPage();
  Object.assign(page.elements[3], { search: true, href: "https://example.com/" });
  const sent = buildRequest({ ...base, page }).body.state.elements[3];
  assert.ok(!("search" in sent) && !("href" in sent));
});

test("readDecision reads the head matching the operation and ignores the rest", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  const d = readDecision({
    operation: { choice: "CLICK", probabilities: { CLICK: 0.9, TYPE: 0.1 } },
    click_target: { choice: "3", probabilities: { 3: 0.8, 4: 0.2 } },
    type_target: { choice: "1", probabilities: { 1: 0.7, 2: 0.3 } },
  }, req);
  assert.equal(d.operation, "CLICK");
  assert.equal(d.e.label, "log in", "the click head decided the target");
});

test("an answer outside the offered set throws and yields no action", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  assert.throws(() => readDecision({ operation: { choice: "LAUNCH_MISSILES", probabilities: {} } }, req), /outside the offered choices/);
  assert.throws(() => readDecision({
    operation: { choice: "CLICK", probabilities: { CLICK: 1 } },
    click_target: { choice: "99", probabilities: { 99: 1 } },
  }, req), /outside the offered choices/);
});

test("confidence is the weaker of the operation and its target", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  const d = readDecision({
    operation: { choice: "CLICK", probabilities: { CLICK: 0.9 } },
    click_target: { choice: "3", probabilities: { 3: 0.4, 4: 0.6 } },
  }, req);
  assert.equal(d.p, 0.4);
});

test("a terminal answer carries no target", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  for (const op of ["DONE", "BLOCKED"]) {
    const d = readDecision({ operation: { choice: op, probabilities: { [op]: 1 } } }, req);
    assert.equal(d.operation, op);
    assert.equal(d.e, undefined);
    assert.ok(OPERATIONS[op], "every terminal operation is described to Jev");
  }
});

test("WAIT is always offered and carries no target, even on a blank page", () => {
  const blank = { url: "https://example.com/", title: "", text: "", elements: [] };
  const req = buildRequest({ ...base, page: blank });
  assert.deepEqual(Object.keys(req.offered).sort(), ["BLOCKED", "DONE", "WAIT"]);
  const d = readDecision({ operation: { choice: "WAIT", probabilities: { WAIT: 0.9 } } }, req);
  assert.equal(d.operation, "WAIT");
  assert.equal(d.e, undefined);
});

test("every offered operation ships a description for Jev to choose on", () => {
  const { body, offered } = buildRequest({ ...base, page: withDropdown() });
  for (const [op, text] of Object.entries(body.questions.operation.criteria)) {
    assert.equal(typeof text, "string");
    assert.ok(text.length > 10, `${op} needs a real description`);
  }
  assert.deepEqual(Object.keys(body.questions.operation.criteria), Object.keys(offered));
});

test("every request asks the goal-met and stuck checks as yes/no questions", () => {
  const { body } = buildRequest({ ...base, page: loginPage() });
  for (const name of Object.keys(CHECKS)) {
    assert.equal(body.questions[name].type, "noul");
    assert.match(body.questions[name].instructions, /log in/, "the check knows the goal");
  }
});

test("readDecision carries the checks, and the operation's own probability", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  const d = readDecision({
    operation: { choice: "CLICK", probabilities: { CLICK: 0.9 } },
    click_target: { choice: "3", probabilities: { 3: 0.4 } },
    goal_met: { noul: 0.1 }, stuck: { noul: 0.2 },
  }, req);
  assert.deepEqual(d.checks, { goal_met: 0.1, stuck: 0.2 });
  assert.equal(d.operation_p, 0.9);
  assert.equal(d.p, 0.4);
});

test("verdict: a confident action runs, an unsure one is handed back", () => {
  const act = (operation_p, checks = { goal_met: 0.1, stuck: 0.1 }) => verdict({ operation: "CLICK", operation_p, checks });
  assert.equal(act(0.9), null);
  assert.equal(act(0.7), null);
  assert.equal(act(0.6), null, "0.6 is the bar");
  assert.equal(act(0.59), "unsure");
  assert.equal(act(0.5), "unsure");
  assert.equal(verdict({ operation: "WAIT", operation_p: 0.3, checks: {} }), null, "WAIT only looks again");
});

test("verdict: DONE needs the goal-met check to agree", () => {
  assert.equal(verdict({ operation: "DONE", operation_p: 1, checks: { goal_met: 0.8 } }), "done");
  assert.equal(verdict({ operation: "DONE", operation_p: 1, checks: { goal_met: 0.4 } }), "unsure");
  assert.equal(verdict({ operation: "DONE", operation_p: 1, checks: {} }), "unsure", "a missing check never verifies");
});

test("verdict: a very sure check stops the run whatever the operation", () => {
  assert.equal(verdict({ operation: "CLICK", operation_p: 0.9, checks: { goal_met: 0.9, stuck: 0 } }), "done");
  assert.equal(verdict({ operation: "CLICK", operation_p: 0.9, checks: { goal_met: 0.1, stuck: 0.9 } }), "blocked");
  assert.equal(verdict({ operation: "BLOCKED", operation_p: 0.6, checks: {} }), "blocked");
});

test("a menu radio or checkbox item is a click target that reports its checked state", () => {
  const page = { url: "https://example.com/", title: "", text: "", elements: [
    { node: 1, role: "menuitemradio", label: "Sort by price", checked: "true", op: "CLICK" },
    { node: 2, role: "menuitemcheckbox", label: "In stock only", checked: "false", op: "CLICK" },
  ] };
  const { targets, body } = buildRequest({ ...base, page, texts: [] });
  assert.deepEqual(Object.keys(targets.CLICK), ["1", "2"]);
  assert.equal(body.questions.click_target.criteria["1"].checked, "true");
  assert.equal(body.questions.click_target.criteria["2"].checked, "false");
});

test("the rules tell Jev to check a filter's own state, not just the results", () => {
  const { body } = buildRequest({ ...base, page: loginPage() });
  assert.match(body.questions.operation.instructions.rules, /do not prove a filter, sort or option was applied/);
});

// A fake header cell: attributes, an optional onclick, the nearest thead/table, and its cursor.
const th = ({ attrs = {}, onclick = null, thead = true, table = {}, cursor = "auto" } = {}) => {
  const el = attrs => ({ getAttribute: n => attrs[n] ?? null });
  return {
    getAttribute: n => attrs[n] ?? null, hasAttribute: n => n in attrs, onclick, cursor,
    closest: s => (s === "thead" ? (thead ? {} : null) : s === "table" ? el(table) : null),
  };
};
const style = e => ({ cursor: e.cursor });

test("a header looks sortable from aria-sort, a sort class, an onclick or a pointer cursor", () => {
  assert.equal(sortableHeader(th(), style), false, "a plain caption is not offered");
  assert.ok(sortableHeader(th({ attrs: { "aria-sort": "none" } }), style));
  assert.ok(sortableHeader(th({ attrs: { class: "sortable" } }), style));
  assert.ok(sortableHeader(th({ attrs: { onclick: "sort(0)" } }), style));
  assert.ok(sortableHeader(th({ onclick: () => {} }), style));
  assert.ok(sortableHeader(th({ cursor: "pointer" }), style));
});

test("a header row of a table with a sort class is sortable, as jQuery tablesorter marks it", () => {
  const sorter = { class: "tablesorter" };
  assert.ok(sortableHeader(th({ attrs: { class: "header" }, table: sorter }), style), "tablesorter's unsorted header");
  assert.equal(sortableHeader(th({ thead: false, table: sorter }), style), false, "a row header in the body is not");
});

test("a header's sort state is its aria-sort, else the sort class as written", () => {
  assert.equal(sortState(th({ attrs: { "aria-sort": "ascending", class: "headerSortUp" } })), "ascending");
  assert.equal(sortState(th({ attrs: { class: "header headerSortDown" } })), "headerSortDown");
  assert.equal(sortState(th({ attrs: { class: "tablesorter-header tablesorter-headerAsc" } })), "tablesorter-headerAsc");
  assert.equal(sortState(th({ attrs: { class: "header sortable" } })), undefined, "sortable is not a state");
});

test("a column header is a click target, and Jev sees its sort state", () => {
  const page = { url: "https://example.com/t", title: "T", text: "", elements: [
    { node: 1, role: "columnheader", label: "Last Name", sort: "headerSortDown", op: "CLICK" },
    { node: 2, role: "columnheader", label: "First Name", op: "CLICK" },
  ] };
  const { body, targets } = buildRequest({ ...base, page });
  assert.deepEqual(Object.keys(targets.CLICK), ["1", "2"]);
  assert.equal(body.questions.click_target.criteria["1"].sort, "headerSortDown");
  assert.equal(body.state.elements[0].sort, "headerSortDown");
  const sorted = { ...page, elements: page.elements.map(e => ({ ...e, sort: e.node === 2 ? "headerSortDown" : undefined })) };
  assert.notEqual(fingerprint(sorted), fingerprint(page), "a sort that moves only the state still counts as a change");
});

test("a blocked verdict says why: Jev answered BLOCKED, or the stuck check reached the stop bar", () => {
  const blocked = d => verdict(d) === "blocked" && blockReason(d);
  assert.equal(blocked({ operation: "BLOCKED", operation_p: 0.9, checks: { goal_met: 0.1, stuck: 0.2 } }), "jev_blocked");
  assert.equal(blocked({ operation: "BLOCKED", operation_p: 0.9, checks: { goal_met: 0.1, stuck: 0.9 } }), "jev_blocked", "Jev's own answer comes first");
  assert.equal(blocked({ operation: "CLICK", operation_p: 0.9, checks: { goal_met: 0.1, stuck: 0.9 } }), "stuck_check");
  assert.equal(blocked({ operation: "WAIT", operation_p: 0.9, checks: { goal_met: 0.1, stuck: 0.86 } }), "stuck_check");
});
