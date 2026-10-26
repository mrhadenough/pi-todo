import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, counts, emptyState, listing, panel, replay, STATE_TYPE, STORAGE_ERROR_TYPE } from "../state.mjs";
import { TaskPanelView } from "../view.mjs";

const add = (state, titles) => apply(state, { action: "add", tasks: titles.map(title => ({ title })) }).state;
const update = (state, changes) => apply(state, { action: "update", changes }).state;
const snapshot = state => ({ type: "custom", customType: STATE_TYPE, data: state });

test("batch creation, compact deltas, optional completion notes, and one atomic handoff", () => {
  const original = emptyState();
  let state = add(original, ["Inspect code", "Fix bug", "Run tests"]);
  assert.deepEqual(original, emptyState());
  assert.deepEqual(state.tasks.map(task => task.id), [1, 2, 3]);
  state = update(state, [{ id: 1, status: "in_progress" }]);
  const result = apply(state, { action: "update", changes: [
    { id: 2, status: "in_progress" }, { id: 1, status: "completed", note: "Reviewed handler" },
  ] });
  assert.deepEqual(counts(result.state), { pending: 1, in_progress: 1, blocked: 0, completed: 1, total: 3 });
  assert.match(result.content, /2\. in_progress; 1\. completed/);
  assert.doesNotMatch(result.content, /Inspect code|Fix bug|Run tests/);
  assert.equal(state.tasks[0].status, "in_progress");
  assert.equal(result.state.revision, 3);
});

test("task rows use distinct status symbols in listings and the widget", () => {
  const initial = apply(emptyState(), { action: "add", tasks: [
    { title: "Done" }, { title: "Working" }, { title: "Waiting", blockedBy: [1] }, { title: "Later" },
  ] });
  assert.match(initial.content, /1\. ☐ Done/);
  const state = update(initial.state, [
    { id: 1, status: "completed" }, { id: 2, status: "in_progress" },
    { id: 3, status: "blocked", note: "Needs access" },
  ]);
  for (const output of [listing(state), panel(state, false, 5, false).map(row => row.text).join("\n")]) {
    for (const row of ["1. ☑ Done", "2. ◐ Working", "3. ✕ Waiting (after 1) — Needs access", "4. ☐ Later"]) {
      assert.ok(output.includes(row), row);
    }
    assert.doesNotMatch(output, /\[(pending|in_progress|blocked|completed)\]/);
  }
});

test("blocked reasons clear on status changes; completion never inferred from another task", () => {
  let state = add(emptyState(), ["Fix", "Verify"]);
  assert.throws(() => update(state, [{ id: 1, status: "blocked" }]), /needs a reason/);
  state = update(state, [{ id: 1, status: "blocked", note: "Waiting for database" }]);
  state = update(state, [{ id: 1, status: "in_progress" }]);
  assert.equal(state.tasks[0].note, "");
  state = update(state, [{ id: 1, status: "completed" }]);
  assert.equal(state.tasks[1].status, "pending");
  assert.match(listing(state), /1\. ☑ Fix/);
});

test("no-op updates neither inflate revision nor require persistence", () => {
  const state = add(emptyState(), ["A"]);
  const result = apply(state, { action: "update", changes: [{ id: 1, status: "pending" }] });
  assert.equal(result.mutated, false);
  assert.equal(result.state.revision, state.revision);
  assert.match(result.content, /No change/);
  assert.equal(apply(state, { action: "list" }).mutated, false);
});

test("clear does not reuse IDs, so stale updates cannot complete new tasks", () => {
  let state = add(emptyState(), ["Old A", "Old B"]);
  state = apply(state, { action: "clear" }).state;
  state = add(state, ["New"]);
  assert.equal(state.tasks[0].id, 3);
  assert.throws(() => update(state, [{ id: 1, status: "completed" }]), /Unknown/);
  assert.equal(apply(emptyState(), { action: "clear" }).mutated, false);
});

test("dependency validation is atomic and allows completion plus dependent start", () => {
  let state = apply(emptyState(), { action: "add", tasks: [
    { title: "A" }, { title: "B", blockedBy: [1] }, { title: "C", blockedBy: [2] },
  ] }).state;
  for (const status of ["in_progress", "completed"]) {
    assert.throws(() => update(state, [{ id: 2, status }]), /unfinished dependencies/);
  }
  state = update(state, [{ id: 2, status: "in_progress" }, { id: 1, status: "completed" }]);
  assert.equal(state.tasks[1].status, "in_progress");
  const before = structuredClone(state);
  assert.throws(() => update(state, [{ id: 1, status: "pending" }]), /unfinished dependencies/);
  assert.deepEqual(state, before);
  state = update(state, [{ id: 2, status: "pending" }, { id: 1, status: "pending" }]);
  assert.equal(state.tasks[0].status, "pending");
});

for (const [label, changes, pattern] of [
  ["two active", [{ id: 1, status: "in_progress" }, { id: 2, status: "in_progress" }], /Only one/],
  ["unknown", [{ id: 99, status: "completed" }], /Unknown/],
  ["duplicate", [{ id: 1, status: "completed" }, { id: 1, status: "pending" }], /duplicate/],
  ["no change fields", [{ id: 1 }], /No changes/],
  ["invalid status", [{ id: 1, status: "magic" }], /Invalid task/],
  ["missing dependency", [{ id: 1, blockedBy: [99] }], /Invalid dependencies/],
  ["self dependency", [{ id: 1, blockedBy: [1] }], /Invalid dependencies/],
  ["duplicate dependencies", [{ id: 2, blockedBy: [1, 1] }], /Invalid dependencies/],
  ["cycle", [{ id: 1, blockedBy: [2] }, { id: 2, blockedBy: [1] }], /cycle/],
  ["blank title", [{ id: 1, title: "   " }], /title/],
  ["long note", [{ id: 1, note: "n".repeat(301) }], /note/],
]) {
  test(`reject ${label} without modifying previous state`, () => {
    const state = add(emptyState(), ["A", "B"]), before = structuredClone(state);
    assert.throws(() => update(state, changes), pattern);
    assert.deepEqual(state, before);
  });
}

test("bad later batch item cannot commit earlier valid items", () => {
  const state = add(emptyState(), ["A", "B"]);
  assert.throws(() => update(state, [{ id: 1, status: "completed" }, { id: 88, status: "completed" }]));
  assert.equal(state.tasks[0].status, "pending");
  assert.throws(() => apply(state, { action: "add", tasks: [{ title: "C" }, { title: "" }] }));
  assert.equal(state.nextId, 3);
});

test("bounds and invalid payloads", () => {
  const full = add(emptyState(), Array.from({ length: 50 }, (_, n) => `Task ${n}`));
  assert.throws(() => add(full, ["Extra"]), /At most 50/);
  assert.throws(() => add(emptyState(), ["x".repeat(161)]), /title/);
  for (const params of [
    { action: "unknown" }, { action: "add", tasks: [] }, { action: "update", changes: [] },
    { action: "list", tasks: [] }, { action: "clear", changes: [] },
    { action: "add", tasks: [{ title: "A" }], changes: [] },
  ]) assert.throws(() => apply(emptyState(), params));
});

test("replay follows only the supplied branch, ignores other extensions, and returns a copy", () => {
  const base = add(emptyState(), ["A"]);
  const done = update(base, [{ id: 1, status: "completed" }]);
  const openBranch = [snapshot(base)], doneBranch = [...openBranch, snapshot(done)];
  assert.equal(replay(doneBranch).tasks[0].status, "completed");
  assert.equal(replay(openBranch).tasks[0].status, "pending");
  const copy = replay(doneBranch);
  copy.tasks[0].status = "pending";
  assert.equal(done.tasks[0].status, "completed");
  assert.deepEqual(replay([{ type: "custom", customType: "another.todo", data: done }]), emptyState());
  assert.deepEqual(replay([]), emptyState());
});

test("corrupt latest snapshots fail closed instead of showing an earlier green plan", () => {
  const complete = update(add(emptyState(), ["A"]), [{ id: 1, status: "completed" }]);
  for (const bad of [undefined, {}, { ...complete, version: 2 }, { ...complete, nextId: 1 },
    { ...complete, tasks: [{ ...complete.tasks[0], title: "\x1b[31mA" }] }]) {
    assert.throws(() => replay([snapshot(complete), snapshot(bad)]));
  }
});

test("ten tasks with three completed fit the requested five-row layout", () => {
  let state = add(emptyState(), Array.from({ length: 10 }, (_, n) => `Task ${n + 1}`));
  state = update(state, [{ id: 1, status: "completed" }, { id: 2, status: "completed" },
    { id: 3, status: "completed" }, { id: 10, status: "in_progress" }]);
  const lines = panel(state, false);
  assert.equal(lines.length, 6); // Heading plus five content rows, summaries included.
  assert.match(lines[0].text, /3\/10 reported complete · agent idle/);
  assert.match(lines[1].text, /▸ 3 completed tasks/);
  assert.match(lines[2].text, /10\. ◐/);
  assert.match(lines[3].text, /4\. ☐/);
  assert.match(lines[4].text, /5\. ☐/);
  assert.match(lines[5].text, /▸ 4 more pending tasks/);
  assert.equal(lines.some(row => row.status === "completed"), false);
  assert.equal(listing(state).split("\n").length, 11); // Full listing is never folded.
  assert.match(panel(state, true)[0].text, /agent busy/);
  assert.equal(state.tasks[9].status, "in_progress"); // Idle is not automatic completion/blocking.
  assert.deepEqual(panel(emptyState(), false), []);
});

test("expanding the ten-task demo reveals all three completed rows and keeps current plus next two", () => {
  let state = add(emptyState(), Array.from({ length: 10 }, (_, n) => `Task ${n + 1}`));
  state = update(state, [{ id: 1, status: "completed" }, { id: 2, status: "completed" },
    { id: 3, status: "completed" }, { id: 4, status: "in_progress" }]);
  const before = structuredClone(state);
  const collapsed = panel(state, false);
  const expanded = panel(state, false, 5, false);
  assert.equal(collapsed.length, 6);
  assert.equal(expanded.length, 9);
  assert.deepEqual(expanded.slice(2, 5).map(row => row.text), ["1. ☑ Task 1", "2. ☑ Task 2", "3. ☑ Task 3"]);
  assert.deepEqual(expanded.slice(5).map(row => row.text), [
    "4. ◐ Task 4", "5. ☐ Task 5", "6. ☐ Task 6", "▸ 4 more pending tasks — /task-plan for all",
  ]);
  assert.deepEqual(panel(state, false), collapsed);
  assert.deepEqual(state, before);
});

test("the next two pending tasks stay visible even with blockers and expanded completion", () => {
  let state = add(emptyState(), Array.from({ length: 10 }, (_, n) => `Task ${n + 1}`));
  state = update(state, [{ id: 1, status: "completed" }, { id: 2, status: "completed" },
    { id: 9, status: "blocked", note: "Missing key" }, { id: 10, status: "in_progress" }]);
  const lines = panel(state, false);
  assert.match(lines[2].text, /10\. ◐/);
  assert.match(lines[3].text, /3\. ☐/);
  assert.match(lines[4].text, /4\. ☐/);
  assert.match(lines[5].text, /More: 1 blocked, 4 pending/);
  const expanded = panel(state, false, 5, false);
  assert.equal(expanded.length, 8); // Collapsed layout plus both completed rows.
  assert.deepEqual(expanded.slice(2, 4).map(row => row.text), ["1. ☑ Task 1", "2. ☑ Task 2"]);
  assert.deepEqual(expanded.slice(4), lines.slice(2)); // Open work keeps its slots.
  assert.match(expanded.at(-1).text, /More: 1 blocked, 4 pending/);
});

test("completed rows fold by default, expand beyond the budget, and reopening makes them visible", () => {
  let state = add(emptyState(), ["First", "Second", "Open"]);
  state = update(state, [{ id: 1, status: "completed" }, { id: 2, status: "completed" }]);
  const before = structuredClone(state);
  assert.deepEqual(panel(state, false).map(row => row.status), ["header", "completed_toggle", "pending"]);
  const expanded = panel(state, false, 5, false);
  assert.deepEqual(expanded.map(row => row.status), ["header", "completed_toggle", "completed", "completed", "pending"]);
  assert.match(expanded[1].text, /▾ 2 completed tasks/);
  assert.deepEqual(state, before); // Neither view mutates the canonical snapshot.
  state = update(state, [{ id: 1, status: "in_progress" }]);
  assert.match(panel(state, false)[2].text, /1\. ◐ First/);
  assert.match(panel(state, false)[1].text, /▸ 1 completed task ·/);
  state = update(state, [{ id: 1, status: "completed" }, { id: 3, status: "completed" }]);
  assert.deepEqual(panel(state, false).map(row => row.status), ["header", "completed_toggle"]);
  assert.match(panel(state, false)[1].text, /▸ 3 completed tasks/);
});

test("collapsed rows respect the cap; expansion adds every completed task without displacing open work", () => {
  for (let total = 1; total <= 50; total++) {
    let state = add(emptyState(), Array.from({ length: total }, (_, n) => `Task ${n + 1}`));
    const pending = panel(state, false);
    assert.equal(pending.length, 1 + Math.min(total, 5));
    if (total > 5) assert.ok(pending.at(-1).text.includes(`${total - 4} more pending tasks`));
    for (let done = 0; done <= total; done++) {
      if (done) state = update(state, [{ id: done, status: "completed" }]);
      const folded = panel(state, false);
      for (const collapsed of [true, false]) {
        const rows = panel(state, false, 5, collapsed);
        assert.ok(rows.length <= 6 + (collapsed ? 0 : done), `${total} tasks, ${done} completed, collapsed=${collapsed}`);
        assert.equal(rows.filter(row => row.status === "completed_toggle").length, done ? 1 : 0);
        assert.equal(rows.filter(row => row.status === "completed").length, collapsed ? 0 : done);
        assert.deepEqual(rows.filter(row => !["completed", "completed_toggle"].includes(row.status)),
          folded.filter(row => row.status !== "completed_toggle"));
      }
    }
  }
});

test("untrusted task text cannot emit terminal controls or bidi formatting", () => {
  const state = add(emptyState(), ["\x1b[31mRed\x1b[0m \x1b]8;;https://evil.test\x07link\x1b]8;;\x07\u202e"]);
  assert.equal(state.tasks[0].title, "Red link");
  assert.doesNotMatch(listing(state), /[\x1b\x07\u202e]/);
});


test("panel focus navigates every task through a five-row viewport without changing task state", () => {
  let state = add(emptyState(), Array.from({ length: 10 }, (_, n) => `Task ${n + 1}`));
  state = update(state, [{ id: 1, status: "completed" }, { id: 2, status: "completed" },
    { id: 3, status: "completed" }, { id: 4, status: "in_progress" }]);
  const before = structuredClone(state);
  const view = new TaskPanelView();
  assert.deepEqual(view.rows(state, false), panel(state, false));
  view.toggleFocus(state);
  assert.equal(view.focused, true);
  assert.equal(view.selectedKey, "completed");
  view.fold(state, false);
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const rows = view.rows(state, true);
    assert.ok(rows.length <= 6);
    assert.match(rows[0].text, /focused.*agent busy/);
    const selected = rows.filter(row => row.selected);
    assert.equal(selected.length, 1);
    assert.match(selected[0].text, /^› /);
    seen.add(selected[0].key);
    view.move(state, 1);
  }
  assert.deepEqual([...seen], ["completed", ...Array.from({ length: 10 }, (_, n) => `task:${n + 1}`)]);
  assert.equal(view.selectedKey, "task:10");
  assert.deepEqual(view.rows(state, false, 5, false), panel(state, false, 5, false));
  assert.equal(view.focused, true); // Overlay suspension never loses selection/focus.
  assert.equal(view.selectedKey, "task:10");
  assert.match(view.rows(state, false)[0].text, /rows 7–11\/11/);
  for (let i = 0; i < 20; i++) view.move(state, -1);
  assert.equal(view.rows(state, false)[1].key, "completed");
  view.toggleFocus(state);
  assert.equal(view.focused, false);
  assert.equal(view.rows(state, false).filter(row => row.status === "completed").length, 3);
  assert.deepEqual(state, before);
});

test("left collapses from a completed child; right only expands the completed group", () => {
  let state = add(emptyState(), ["Done", "Current"]);
  state = update(state, [{ id: 1, status: "completed" }, { id: 2, status: "in_progress" }]);
  const view = new TaskPanelView();
  view.toggleFocus(state);
  view.fold(state, false);
  view.move(state, 1);
  assert.equal(view.selectedKey, "task:1");
  view.fold(state, true);
  assert.equal(view.completedCollapsed, true);
  assert.equal(view.selectedKey, "completed");
  view.move(state, 1);
  assert.equal(view.selectedKey, "task:2");
  view.fold(state, false);
  assert.equal(view.completedCollapsed, true);
  view.fold(state, true);
  assert.equal(view.selectedKey, "task:2");
});

test("selection follows task IDs across live updates and falls back when a row is folded or cleared", () => {
  let state = add(emptyState(), ["First", "Second", "Third"]);
  const view = new TaskPanelView();
  view.toggleFocus(state);
  view.move(state, 1);
  state = update(state, [{ id: 2, status: "in_progress" }]);
  assert.equal(view.rows(state, true).find(row => row.selected).id, 2);
  state = update(state, [{ id: 2, status: "completed" }]);
  assert.equal(view.rows(state, false).find(row => row.selected).key, "completed");
  view.toggleCompleted(state);
  view.move(state, 1);
  assert.equal(view.selectedKey, "task:2");
  state = update(state, [{ id: 2, status: "in_progress" }]);
  assert.equal(view.rows(state, true).find(row => row.selected).id, 2);
  state = apply(state, { action: "clear" }).state;
  assert.deepEqual(view.rows(state, false), []);
  assert.equal(view.focused, false);
  assert.equal(view.selectedKey, undefined);
});

test("empty plans cannot focus and resetting restores collapsed unfocused presentation", () => {
  const view = new TaskPanelView();
  view.toggleFocus(emptyState());
  assert.equal(view.focused, false);
  const state = update(add(emptyState(), ["Done"]), [{ id: 1, status: "completed" }]);
  view.toggleFocus(state);
  view.fold(state, false);
  view.move(state, 1);
  view.reset();
  assert.equal(view.focused, false);
  assert.equal(view.completedCollapsed, true);
  assert.equal(view.selectedKey, undefined);
  assert.equal(view.top, 0);
  assert.deepEqual(view.rows(state, false), panel(state, false));
});

test("all fifty completed tasks remain reachable with a visible selection at both scroll boundaries", () => {
  let state = add(emptyState(), Array.from({ length: 50 }, (_, n) => `Task ${n + 1}`));
  state = update(state, state.tasks.map(task => ({ id: task.id, status: "completed" })));
  const view = new TaskPanelView();
  view.toggleFocus(state);
  view.fold(state, false);
  for (let i = 0; i <= 50; i++) {
    const selected = view.rows(state, false).filter(row => row.selected);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].key, i ? `task:${i}` : "completed");
    view.move(state, 1);
  }
  assert.match(view.rows(state, false)[0].text, /rows 47–51\/51/);
  view.fold(state, true);
  assert.equal(view.rows(state, false).length, 2);
  assert.equal(view.rows(state, false)[1].selected, true);
});


test("storage failure markers lock out dirty branches across extension reload", () => {
  const state = add(emptyState(), ["Still pending"]);
  const branch = [snapshot(state)];
  const failed = [...branch, { type: "custom", customType: STORAGE_ERROR_TYPE, data: { version: 1 } }];
  assert.throws(() => replay(failed), /storage failed/);
  assert.throws(() => replay([...failed, snapshot(state)]), /storage failed/);
  assert.equal(replay(branch).tasks[0].status, "pending"); // Branch/reopen before the fault remains valid.
});
