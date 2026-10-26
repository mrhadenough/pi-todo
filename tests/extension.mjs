// Integration tests use Pi's real loader/SessionManager, no model or credentials.
// node tests/extension.mjs <pi-package-dir> <empty-working-directory>
import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, mkdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listing, replay, STATE_TYPE } from "../state.mjs";
import { hostModuleUrl } from "./sdk-modules.mjs";

const [piDir, cwd] = process.argv.slice(2);
const moduleUrl = path => pathToFileURL(resolve(piDir, path));
const { loadExtensions } = await import(moduleUrl("dist/core/extensions/loader.js"));
const { SessionManager } = await import(moduleUrl("dist/core/session-manager.js"));
const { visibleWidth, matchesKey, ScrollView, Text, TuiAltScreen, TuiMainScreen } = await import(hostModuleUrl(piDir, "@earendil-works/pi-tui"));
const extensionPath = resolve(import.meta.dirname, "../index.ts");
const beforeFiles = readdirSync(cwd);

async function fixture(manager = SessionManager.inMemory(cwd), mode = "tui", renderer) {
  const loaded = await loadExtensions([extensionPath], cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const messages = [], notices = [], editorInput = [];
  const inputListeners = new Set();
  let widget, status, failPersist = false, idle = true, confirm = true, overlay = false;
  const widgetTui = renderer ?? { hasOverlay: () => overlay };
  loaded.runtime.appendEntry = (type, data) => {
    if (failPersist) throw Error("Simulated persistence failure");
    manager.appendCustomEntry(type, data);
  };
  loaded.runtime.sendMessage = (message, options) => {
    assert.equal(options.triggerTurn, false);
    messages.push(message);
    manager.appendCustomMessageEntry(message.customType, message.content, message.display);
  };
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", sessionManager: manager,
    isIdle: () => idle,
    ui: {
      theme: { fg: (_color, text) => text, inverse: text => `\x1b[7m${text}\x1b[27m` },
      onTerminalInput(handler) {
        inputListeners.add(handler);
        const unsubscribe = renderer?.addInputListener(handler);
        return () => { inputListeners.delete(handler); unsubscribe?.(); };
      },
      setWidget(_key, value) {
        if (renderer && widget?.render) renderer.removeChild(widget);
        widget = typeof value === "function" ? value(widgetTui) : value;
        if (renderer && widget?.render) renderer.addChild(widget);
        renderer?.requestRender();
      },
      setStatus(_key, value) { status = value; },
      notify: (...args) => notices.push(args),
      confirm: async () => confirm,
    },
  };
  const tool = extension.tools.get("task_plan").definition;
  async function emit(name, event = {}) {
    let value;
    for (const handler of extension.handlers.get(name) ?? []) {
      value = await handler(event, ctx);
      for (const entry of value?.entries ?? []) {
        assert.equal(entry.type, "custom_message");
        manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
      }
    }
    return value;
  }
  const result = {
    loaded, extension, manager, ctx, tool, messages, notices, emit, editorInput, inputListeners,
    overlay: value => { overlay = value; },
    call: params => tool.execute("test", params, undefined, undefined, ctx),
    state: () => replay(manager.getBranch()),
    lines: width => widget?.render ? widget.render(width) : widget,
    status: () => status,
    persistFailure: value => { failPersist = value; },
    idle: value => { idle = value; },
    confirm: value => { confirm = value; },
    command: args => extension.commands.get("task-plan").handler(args, ctx),
    toggleCompleted: () => extension.commands.get("task-plan").handler("completed", ctx),
    toggleFocus: () => extension.shortcuts.get("ctrl+shift+t").handler(ctx),
    async key(data) {
      for (const listener of inputListeners) {
        const result = listener(data);
        if (result?.consume) return true;
        if (result?.data !== undefined) data = result.data;
      }
      if (matchesKey(data, "ctrl+shift+t")) {
        await extension.shortcuts.get("ctrl+shift+t").handler(ctx);
        return true;
      }
      editorInput.push(data);
      return false;
    },
  };
  await emit("session_start");
  return result;
}

const a = await fixture();
assert.deepEqual([...a.extension.tools.keys()], ["task_plan"]);
assert.equal(a.tool.executionMode, "sequential");
assert.deepEqual(a.messages, []);
const promptChars = a.tool.description.length + a.tool.promptSnippet.length +
  a.tool.promptGuidelines.join("\n").length + JSON.stringify(a.tool.parameters).length;
assert.ok(promptChars <= 2600, `Prompt/schema budget exceeded: ${promptChars}`);
console.log(`pi-todo declaration budget: ${promptChars} characters (not a tokenizer measurement).`);
assert.equal(a.lines(80), undefined);

await a.call({ action: "add", tasks: [{ title: "修复 bug" }, { title: "Verify", blockedBy: [1] }] });
const initialLeaf = a.manager.getLeafId();
await a.emit("agent_start");
await a.call({ action: "update", changes: [{ id: 1, status: "in_progress" }] });
assert.match(a.lines(100)[0], /agent busy/);
const handoff = await a.call({ action: "update", changes: [
  { id: 1, status: "completed" }, { id: 2, status: "in_progress" },
] });
const handoffLeaf = a.manager.getLeafId();
assert.match(handoff.content[0].text, /1\/2 completed/);
assert.match(a.lines(100)[0], /1\/2 reported complete/);
await a.emit("agent_settled");
assert.match(a.lines(100)[0], /agent idle/);
assert.equal(a.state().tasks[1].status, "in_progress");
assert.equal(a.messages.length, 0); // No routine reminders or auto-continuation.
assert.match(a.lines(100)[1], /▸ 1 completed task/);
assert.equal(a.lines(100).some(line => line.includes("1. ☑")), false);
const beforeFoldEntries = a.manager.getEntries().length;
a.idle(false); // Folding must work while the agent is running.
await a.toggleCompleted();
assert.match(a.lines(100)[1], /▾ 1 completed task/);
assert.ok(a.lines(100).some(line => line.includes("1. ☑")));
assert.ok(a.lines(100).some(line => line.includes("2. ◐")));
await a.command("completed");
assert.equal(a.lines(100).some(line => line.includes("1. ☑")), false);
await a.toggleCompleted(); // Reload below must restore the default collapsed view.
a.idle(true);
assert.equal(a.manager.getEntries().length, beforeFoldEntries);
assert.equal(a.messages.length, 0); // Presentation toggles never send model messages.
assert.ok(a.lines(10).every(line => visibleWidth(line) <= 10));
assert.ok(a.lines(1).every(line => visibleWidth(line) <= 1));
a.ctx.ui.theme = { fg: (_color, text) => `\x1b[31m${text}\x1b[0m`, inverse: text => `\x1b[7m${text}\x1b[27m` };
assert.ok(a.lines(40).every(line => visibleWidth(line) <= 40));
assert.ok(a.lines(40)[0].includes("\x1b[31m"));

let unchanged = listing(a.state());
const entriesBefore = a.manager.getEntries().length;
await a.call({ action: "list" });
await a.call({ action: "update", changes: [{ id: 2, status: "in_progress" }] });
assert.equal(a.manager.getEntries().length, entriesBefore); // No-op/read don't write snapshots.
const fault = await fixture();
await fault.call({ action: "add", tasks: [{ title: "Not saved" }] });
const faultBefore = listing(fault.state());
await fault.toggleFocus();
assert.match(fault.lines(100)[0], /focused/);
fault.persistFailure(true);
await assert.rejects(fault.call({ action: "update", changes: [{ id: 1, status: "completed" }] }), /storage failed/);
assert.equal(listing(fault.state()), faultBefore);
assert.match(fault.status(), /unavailable/);
assert.equal(await fault.key("\x1b[B"), false); // Persistence failure releases capture.
await assert.rejects(fault.call({ action: "list" }), /storage failed/);
const abort = new AbortController(); abort.abort();
await assert.rejects(a.tool.execute("abort", { action: "clear" }, abort.signal, undefined, a.ctx), /cancelled/);
assert.equal(listing(a.state()), unchanged);

// Real branch navigation must recover the state on that branch, not a cached green list.
a.manager.branch(initialLeaf);
await a.emit("session_tree");
assert.equal(a.state().tasks[0].status, "pending");
assert.match(a.lines(100)[0], /0\/2/);
a.manager.branch(handoffLeaf);
await a.emit("session_tree");
assert.equal(a.state().tasks[1].status, "in_progress");

// Reload reconstructs from branch metadata, not old globals or tool-result details.
await a.toggleFocus();
await a.emit("session_shutdown");
assert.equal(a.inputListeners.size, 0);
const reloaded = await fixture(a.manager);
assert.equal(listing(reloaded.state()), unchanged);
assert.doesNotMatch(reloaded.lines(100)[0], /focused/);
assert.match(reloaded.lines(100)[0], /1\/2/);
assert.match(reloaded.lines(100)[1], /▸ 1 completed task/);
assert.equal(reloaded.lines(100).some(line => line.includes("1. ☑")), false);
a.manager.appendCompaction("Compacted conversation", handoffLeaf, 10_000);
await reloaded.emit("session_compact");
assert.equal(reloaded.messages.length, 0); // Never queue a potentially stale snapshot while streaming.
const recovery = await reloaded.emit("context", { messages: a.manager.buildSessionContext().messages });
assert.match(recovery.messages.at(-1).content, /2\. ◐ Verify/);
await reloaded.call({ action: "update", changes: [{ id: 2, status: "completed" }] });
await reloaded.emit("turn_end", { entries: [] });
const checkpoint = a.manager.buildSessionContext().messages.find(message => message.customType === "ccc.task-plan.checkpoint.v1");
assert.match(checkpoint.content, /2\. ☑ Verify/); // Persist latest, not pre-tool status.
assert.equal(a.manager.buildSessionContext().messages.some(message => message.customType === STATE_TYPE), false);
assert.equal(await reloaded.emit("context", { messages: a.manager.buildSessionContext().messages }), undefined);
await reloaded.call({ action: "update", changes: [{ id: 2, status: "in_progress" }] });
unchanged = listing(a.state());

const other = await fixture();
assert.equal(other.state().tasks.length, 0);
await assert.rejects(a.tool.execute("foreign", { action: "clear" }, undefined, undefined, other.ctx), /different session; load the extension in that session separately/);
assert.equal(listing(a.state()), unchanged);

await reloaded.command("hide");
assert.equal(reloaded.lines(100), undefined);
await reloaded.command("show");
assert.match(reloaded.lines(100)[0], /1\/2/);
await reloaded.command("");
assert.match(reloaded.notices.at(-1)[0], /2\. ◐/);
reloaded.idle(false);
await reloaded.toggleFocus();
await reloaded.command("clear");
assert.match(reloaded.notices.at(-1)[0], /idle/);
assert.doesNotMatch(reloaded.lines(100)[0], /focused/);
reloaded.idle(true); reloaded.confirm(false);
await reloaded.command("clear");
assert.equal(reloaded.state().tasks.length, 2);
reloaded.confirm(true);
await reloaded.toggleFocus();
await reloaded.command("clear");
assert.equal(reloaded.state().tasks.length, 0);
assert.equal(reloaded.messages.length, 1);
assert.equal(reloaded.lines(100), undefined);
assert.equal(await reloaded.key("\x1b[B"), false);
await reloaded.call({ action: "add", tasks: [{ title: "New task" }] });
assert.equal(reloaded.state().tasks[0].id, 3);
await reloaded.toggleFocus();
await reloaded.call({ action: "clear" });
assert.equal(reloaded.lines(100), undefined);
assert.equal(await reloaded.key("\x1b[A"), false);
await reloaded.call({ action: "add", tasks: [{ title: "Another task" }] });
await reloaded.toggleFocus();

// Corrupt latest metadata must show an error, not retain earlier completed counts.
a.manager.appendCustomEntry(STATE_TYPE, { version: 99 });
await reloaded.emit("session_tree");
assert.match(reloaded.status(), /unavailable/);
assert.match(reloaded.lines(100)[0], /no older status restored/);
assert.equal(await reloaded.key("\x1b[B"), false);
await assert.rejects(reloaded.call({ action: "list" }), /Invalid/);

// Exercise the actual SDK failure ordering: memory changes before disk append.
const sessionDir = mkdtempSync(resolve(tmpdir(), "pi-todo-sessions-"));
try {
  const disk = SessionManager.create(cwd, sessionDir);
  disk.appendMessage({ role: "user", content: "Track work", timestamp: Date.now() });
  const persisted = await fixture(disk);
  await persisted.call({ action: "add", tasks: [{ title: "Still open" }] });
  const file = disk.getSessionFile();
  renameSync(file, file + ".saved");
  mkdirSync(file); // Make appendFileSync fail with EISDIR, outside the project.
  await assert.rejects(persisted.call({ action: "update", changes: [{ id: 1, status: "completed" }] }), /storage failed/);
  assert.equal(disk.getBranch().filter(entry => entry.customType === STATE_TYPE).at(-1).data.tasks[0].status, "completed");
  assert.throws(() => replay(disk.getBranch()), /storage failed/); // Dirty memory is never a valid plan.
  const dirtyReload = await fixture(disk); // /reload retains the SDK manager, not a fresh disk read.
  assert.match(dirtyReload.status(), /unavailable/);
  await assert.rejects(dirtyReload.call({ action: "list" }), /storage failed/);
  assert.match(persisted.status(), /unavailable/); // Never green/stale despite that branch.
  await assert.rejects(persisted.call({ action: "list" }), /storage failed/);
  rmdirSync(file);
  renameSync(file + ".saved", file);
  const reopened = await fixture(SessionManager.open(file, sessionDir));
  assert.equal(reopened.state().tasks[0].status, "pending");
  assert.match(reopened.lines(100)[0], /0\/1 reported complete/);
} finally { rmSync(sessionDir, { recursive: true, force: true }); }

// The requested ten-task example fits five content rows and keeps the active task visible.
const crowded = await fixture();
await crowded.call({ action: "add", tasks: Array.from({ length: 10 }, (_, n) => ({ title: `Task ${n + 1}` })) });
await crowded.call({ action: "update", changes: [
  { id: 1, status: "completed" }, { id: 2, status: "completed" },
  { id: 3, status: "completed" }, { id: 10, status: "in_progress" },
] });
assert.equal(crowded.lines(100).length, 6);
assert.match(crowded.lines(100)[1], /▸ 3 completed tasks/);
assert.match(crowded.lines(100)[2], /10\. ◐/);
assert.match(crowded.lines(100)[5], /▸ 4 more pending tasks/);
const crowdedEntries = crowded.manager.getEntries().length;
await crowded.toggleCompleted();
assert.equal(crowded.lines(100).length, 9);
assert.match(crowded.lines(100)[1], /▾ 3 completed tasks/);
for (const id of [1, 2, 3]) assert.match(crowded.lines(100)[id + 1], new RegExp(`${id}\\. ☑`));
assert.match(crowded.lines(100)[5], /10\. ◐/);
assert.match(crowded.lines(100)[6], /4\. ☐/);
assert.match(crowded.lines(100)[7], /5\. ☐/);
assert.match(crowded.lines(100).at(-1), /4 more pending tasks/);
for (const width of [1, 10, 40]) assert.ok(crowded.lines(width).every(line => visibleWidth(line) <= width));
await crowded.command("completed");
assert.equal(crowded.lines(100).length, 6);
assert.equal(crowded.lines(100).some(line => line.includes("☑")), false);
await crowded.command("completed");
assert.equal(crowded.lines(100).filter(line => line.includes("☑")).length, 3);
assert.equal(crowded.manager.getEntries().length, crowdedEntries);
assert.equal(crowded.messages.length, 0);
await crowded.command("hide");
await crowded.toggleCompleted();
assert.equal(crowded.lines(100), undefined); // Folding never unhides the whole panel.
await crowded.command("show");
assert.match(crowded.lines(100)[1], /▸ 3 completed tasks/);
for (const width of [1, 10, 40]) assert.ok(crowded.lines(width).every(line => visibleWidth(line) <= width));
// Logical widget focus owns only navigation input, never the task snapshot.
const focusEntries = crowded.manager.getEntries().length;
const focusState = structuredClone(crowded.state());
assert.equal(crowded.inputListeners.size, 1);
const ctrlShiftT = "\x1b[116;6u";
const selectedLine = f => f.lines(120).find(line => line.includes("› "));
crowded.idle(false);
await crowded.emit("agent_start");
await crowded.key(ctrlShiftT);
assert.match(crowded.lines(120)[0], /focused/);
assert.match(selectedLine(crowded), /› ▸ 3 completed tasks/);
assert.match(selectedLine(crowded), /\x1b\[7m/); // Selection has a themed inverse highlight.
assert.equal(crowded.lines(120).some(line => line.includes("☑")), false);
await crowded.key("\x1b[C"); // Right expands, not task status.
assert.equal(crowded.lines(120).length, 6); // Focused view scrolls within five content rows.
assert.equal(crowded.lines(120).filter(line => line.includes("☑")).length, 3);
await crowded.key("\x1b[B");
assert.match(selectedLine(crowded), /1\. ☑/);
await crowded.key("\x1b[65;1:3u"); // Key-release events never move selection.
assert.match(selectedLine(crowded), /1\. ☑/);
await crowded.key("\x1b[D"); // Left from a completed child collapses its group.
assert.match(selectedLine(crowded), /› ▸ 3 completed tasks/);
await crowded.key("\x1b[C");
for (let i = 0; i < 20; i++) await crowded.key("\x1b[B");
assert.match(selectedLine(crowded), /9\. ☐/); // Previously summarized pending rows are reachable.
assert.match(crowded.lines(120)[0], /rows 7–11\/11/);
for (const width of [0, 1, 10, 40]) assert.ok(crowded.lines(width).every(line => visibleWidth(line) <= width));
assert.equal(crowded.editorInput.length, 0);
await crowded.key("\x1b"); // Escape releases focus without reaching the agent/editor.
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
assert.equal(crowded.editorInput.length, 0);
assert.equal(crowded.lines(120).length, 9); // Unfocused expansion adds all completed rows.
assert.equal(await crowded.key("\x1b[A"), false); // Normal editor arrows remain untouched.
await crowded.key(ctrlShiftT);
await crowded.key(ctrlShiftT); // Raw listener must not blur then refocus via the shortcut.
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
await crowded.command("focus");
assert.match(crowded.lines(120)[0], /focused/);
assert.equal(await crowded.key("x"), false); // Typing blurs and passes through unchanged.
assert.equal(crowded.editorInput.at(-1), "x");
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
await crowded.toggleFocus();
assert.equal(await crowded.key("\n"), false); // Legacy Ctrl+J is a newline, not submission.
assert.equal(crowded.editorInput.at(-1), "\n");
for (const data of ["\x1b[200~pasted\ntext\x1b[201~", "\x1b[1;2A", "\x1b[106;5u", "\x1b\r"]) {
  await crowded.toggleFocus();
  assert.equal(await crowded.key(data), false);
  assert.equal(crowded.editorInput.at(-1), data);
  assert.doesNotMatch(crowded.lines(120)[0], /focused/);
}
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
await crowded.toggleFocus();
const beforeEnter = crowded.editorInput.length;
assert.equal(await crowded.key("\r"), true); // Enter returns focus without submitting the prompt.
assert.equal(crowded.editorInput.length, beforeEnter);
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
await crowded.toggleFocus();
assert.equal(await crowded.key("\x03"), false); // Ctrl+C remains available to abort the agent.
assert.equal(crowded.editorInput.at(-1), "\x03");
await crowded.toggleFocus();
const beforeOverlaySelection = selectedLine(crowded);
crowded.overlay(true); // Fullscreen search can open before our raw listener.
assert.doesNotMatch(crowded.lines(120)[0], /focused/); // Highlight is suspended, not stolen.
await crowded.toggleFocus(); // Do not change panel focus over another interaction.
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
crowded.overlay(false);
assert.match(crowded.lines(120)[0], /focused/);
assert.equal(selectedLine(crowded), beforeOverlaySelection);
crowded.overlay(true);
assert.equal(await crowded.key("\x1b[A"), false); // Protect overlays before their first render too.
crowded.overlay(false);
assert.match(crowded.lines(120)[0], /focused/);
assert.equal(selectedLine(crowded), beforeOverlaySelection);
await crowded.emit("ui_prompt_start"); // Extension dialogs deliberately release logical focus.
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
await crowded.toggleFocus();
await crowded.command("hide");
await crowded.toggleFocus();
assert.equal(crowded.lines(120), undefined);
assert.equal(await crowded.key("\x1b[B"), false);
await crowded.command("show");
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
await crowded.toggleFocus();
await crowded.emit("session_tree");
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
assert.deepEqual(crowded.state(), focusState);
assert.equal(crowded.manager.getEntries().length, focusEntries);
assert.equal(crowded.messages.length, 0);
await crowded.emit("session_start"); // Re-registering replaces, never accumulates input listeners.
assert.equal(crowded.inputListeners.size, 1);
assert.doesNotMatch(crowded.lines(120)[0], /focused/);
assert.equal(crowded.lines(120).some(line => line.includes("☑")), false);

await crowded.emit("session_shutdown");

assert.equal(crowded.inputListeners.size, 0);
assert.equal(await crowded.key("\x1b[A"), false);

// Exercise real regular/fullscreen TUI listener ordering with an in-memory terminal.
// This is not a real-terminal screenshot or visual acceptance test.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  const terminal = {
    columns: 120, rows: 30, kittyProtocolActive: false,
    start(onInput) { this.input = onInput; },
    stop() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {},
    setProgress() {}, setProgramStatus() {}, async drainInput() {},
  };
  const renderer = new Renderer(terminal);
  renderer.addChild(new ScrollView(new Text("Transcript for search", 0, 0), { primary: true }));
  const routed = await fixture(undefined, "tui", renderer);
  const editor = {
    render: () => ["Prompt"], invalidate() {},
    handleInput(data) {
      if (matchesKey(data, "ctrl+shift+t")) routed.extension.shortcuts.get("ctrl+shift+t").handler(routed.ctx);
      else routed.editorInput.push(data);
    },
  };
  renderer.addChild(editor);
  renderer.setFocus(editor);
  renderer.start();
  try {
    await routed.call({ action: "add", tasks: [{ title: "Done" }, { title: "Current" }] });
    await routed.call({ action: "update", changes: [{ id: 1, status: "completed" }, { id: 2, status: "in_progress" }] });
    renderer.renderNow();
    terminal.input(ctrlShiftT);
    renderer.renderNow();
    assert.match(routed.lines(120)[0], /focused/);
    terminal.input("\x1b[C");
    assert.equal(routed.editorInput.length, 0);
    assert.ok(routed.lines(120).some(line => line.includes("1. ☑")));
    if (Renderer === TuiAltScreen) {
      terminal.input("\x1b[102;6u"); // Fullscreen search is intercepted before extension listeners.
      assert.equal(renderer.hasOverlay(), true);
      renderer.renderNow();
      assert.doesNotMatch(routed.lines(120)[0], /focused/);
      const beforeSearchArrow = [...routed.lines(120)];
      terminal.input("\x1b[A");
      assert.deepEqual(routed.lines(120), beforeSearchArrow);
      terminal.input("\x1b");
      assert.equal(renderer.hasOverlay(), false);
      assert.match(routed.lines(120)[0], /focused/); // Native overlay closure restores panel focus.
      terminal.input("x");
      assert.equal(routed.editorInput.at(-1), "x");
      assert.doesNotMatch(routed.lines(120)[0], /focused/);
      terminal.input(ctrlShiftT);
      const beforeFastSearch = [...routed.lines(120)];
      terminal.input("\x1b[102;6u");
      terminal.input("\x1b"); // Open/close before rendering: same restoration semantics, no race.
      assert.equal(renderer.hasOverlay(), false);
      assert.deepEqual(routed.lines(120), beforeFastSearch);
      terminal.input("\x1b");
      assert.doesNotMatch(routed.lines(120)[0], /focused/);
    } else {
      terminal.input("\x1b");
      assert.doesNotMatch(routed.lines(120)[0], /focused/);
      assert.equal(routed.editorInput.length, 0);
    }
    terminal.input(ctrlShiftT);
    terminal.input("\n"); // Ctrl+J remains a newline under actual legacy TUI routing.
    assert.equal(routed.editorInput.at(-1), "\n");
    assert.doesNotMatch(routed.lines(120)[0], /focused/);
  } finally {
    await routed.emit("session_shutdown");
    renderer.stop();
  }
}

for (const mode of ["print", "json", "rpc"]) {
  const headless = await fixture(undefined, mode);
  headless.ctx.ui.setWidget = () => { throw Error("terminal UI is unavailable"); };
  assert.equal(headless.inputListeners.size, 0);
  headless.ctx.ui.onTerminalInput = () => { throw Error("terminal input is unavailable"); };
  headless.ctx.ui.setStatus = () => { throw Error("terminal UI is unavailable"); };
  await headless.call({ action: "add", tasks: [{ title: "Headless" }] });
  await headless.emit("agent_start");
  await headless.emit("agent_settled");
  assert.equal(headless.state().tasks[0].status, "pending");
  const headlessEntries = headless.manager.getEntries().length;
  await headless.toggleCompleted();
  await headless.toggleFocus();
  await headless.command("focus");
  await headless.command("completed");
  assert.equal(headless.manager.getEntries().length, headlessEntries);
  await headless.emit("session_shutdown");
}
await reloaded.emit("session_shutdown");
assert.equal(reloaded.lines(100), undefined);
assert.deepEqual(readdirSync(cwd), beforeFiles);
console.log("pi-todo SDK integration passed: reload, branch, compaction, isolation, UI, and persistence failure; no model calls/project files.");
