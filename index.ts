import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { apply, counts, listing, replay, STATE_TYPE, STORAGE_ERROR_TYPE, STATUSES } from "./state.mjs";
import { TaskPanelView } from "./view.mjs";

const KEY = "ccc-task-plan";
const CHECKPOINT = "ccc.task-plan.checkpoint.v1";
const dependencies = Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50 });
const parameters = Type.Object({
  action: StringEnum(["add", "update", "list", "clear"] as const),
  tasks: Type.Optional(Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 160 }),
    blockedBy: Type.Optional(dependencies),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 50 })),
  changes: Type.Optional(Type.Array(Type.Object({
    id: Type.Integer({ minimum: 1 }),
    status: Type.Optional(StringEnum(STATUSES)),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    blockedBy: Type.Optional(dependencies),
    note: Type.Optional(Type.String({ maxLength: 300 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 50 })),
}, { additionalProperties: false });

export default function taskPlan(pi: ExtensionAPI) {
  let ownerId: string | undefined;
  let failedStorageOwner: string | undefined;
  let busy = false;
  let hidden = false;
  const view = new TaskPanelView();
  let unsubscribeInput: (() => void) | undefined;
  let panelTui: TUI | undefined;

  function current(ctx: ExtensionContext) {
    if (!ownerId || ctx.sessionManager.getSessionId() !== ownerId) {
      throw new Error("Task plan belongs to a different session; load the extension in that session separately");
    }
    if (failedStorageOwner === ownerId) {
      throw new Error("Task-plan storage failed. Fix session storage and reopen the saved session before continuing.");
    }
    return replay(ctx.sessionManager.getBranch());
  }

  function paint(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== ownerId) return;
    try {
      const state = current(ctx);
      const n = counts(state);
      if (hidden || !n.total) view.blur();
      view.reconcile(state);
      ctx.ui.setStatus(KEY, n.total ? `tasks ${n.completed}/${n.total} reported · ${busy ? "busy" : "idle"}` : undefined);
      ctx.ui.setWidget(KEY, hidden || !n.total ? undefined : (tui) => {
        panelTui = tui;
        return {
          render(width: number) {
            // Native overlays (including fullscreen search) temporarily own input.
            // Suspend the highlight as well; retain selection/focus for restoration.
            const colors = { header: "accent", pending: "muted", in_progress: "accent", blocked: "warning", completed: "success", completed_toggle: "dim", overflow: "dim" } as const;
            return view.rows(state, busy, 5, !tui.hasOverlay()).map(row => {
              const text = ctx.ui.theme.fg(colors[row.status], row.text);
              return truncateToWidth(row.selected ? ctx.ui.theme.inverse(text) : text, width);
            });
          },
          invalidate() {},
        };
      });
    } catch {
      view.blur();
      // Never keep an older green checklist on screen after replay fails. A
      // stale UI must also not turn an already-persisted tool update into failure.
      try {
        ctx.ui.setStatus(KEY, "task plan unavailable");
        ctx.ui.setWidget(KEY, ["Task plan unavailable; inspect session state (no older status restored)."]);
      } catch { /* Context invalidated during reload/shutdown. */ }
    }
  }

  function change(params, ctx: ExtensionContext) {
    const result = apply(current(ctx), params);
    if (result.mutated) {
      try { pi.appendEntry(STATE_TYPE, result.state); }
      catch (error) {
        // Pi may update its in-memory branch before a disk append fails. We
        // cannot roll back its raw history: fail closed, never show old green
        // status or claim the new snapshot is durably saved.
        failedStorageOwner = ownerId;
        // Pi's dirty in-memory branch survives /reload. Record a diagnostic
        // marker there too; another disk failure may prevent its persistence,
        // but the new extension instance can still refuse that dirty branch.
        try { pi.appendEntry(STORAGE_ERROR_TYPE, { version: 1 }); } catch { /* Disk may still be unavailable. */ }
        paint(ctx);
        throw new Error("Task-plan storage failed. Fix session storage and reopen the saved session.", { cause: error });
      }
    }
    paint(ctx);
    return {
      content: [{ type: "text" as const, text: result.content }],
      details: { revision: result.state.revision, counts: counts(result.state) },
    };
  }

  function checkpoint(ctx: ExtensionContext) {
    const state = current(ctx);
    // One exact checkpoint after compaction (or a user-command clear), not a
    // repeated per-turn reminder. Never starts an additional model request.
    pi.sendMessage({ customType: CHECKPOINT, content: "Current task plan; statuses are model-reported, not independently verified.\n" + listing(state),
      display: false }, { triggerTurn: false });
  }

  function recoveryCheckpoint(ctx: ExtensionContext) {
    if (ctx.sessionManager.getSessionId() !== ownerId) return;
    const compaction = ctx.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
    const state = current(ctx);
    if (!compaction || !state.tasks.length) return;
    const alreadyPresent = ctx.sessionManager.buildSessionProjection().messages.some(message =>
      message.role === "custom" && message.customType === CHECKPOINT &&
      message.details?.compactionId === compaction.id);
    if (alreadyPresent) return;
    return {
      type: "custom_message" as const, customType: CHECKPOINT, display: false,
      content: "Current task plan; statuses are model-reported, not independently verified.\n" + listing(state),
      details: { compactionId: compaction.id, revision: state.revision },
    };
  }

  // A compaction can happen between tool rounds. Supply the exact state to the
  // first post-compaction request, then persist the LATEST state at a safe
  // boundary. Queuing an old snapshot here could put stale status after a new
  // tool result. Once persisted, ordinary turns inject nothing.
  pi.on("context", (event, ctx) => {
    const draft = recoveryCheckpoint(ctx);
    if (!draft) return;
    const { type: _type, ...message } = draft;
    return { messages: [...event.messages, { ...message, role: "custom" as const, timestamp: Date.now() }] };
  });
  for (const boundary of ["turn_end", "agent_before_settle"] as const) {
    pi.on(boundary, (event, ctx) => {
      const draft = recoveryCheckpoint(ctx);
      return draft ? { entries: [...event.entries, draft] } : undefined;
    });
  }

  pi.on("session_start", (_event, ctx) => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    ownerId = ctx.sessionManager.getSessionId();
    busy = !ctx.isIdle();
    hidden = false;
    view.reset();
    if (ctx.mode === "tui") unsubscribeInput = ctx.ui.onTerminalInput(data => handlePanelInput(data, ctx));
    paint(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== ownerId) return;
    view.blur();
    paint(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== ownerId) return;
    paint(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== ownerId) return;
    busy = true;
    paint(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== ownerId) return;
    busy = false; // Idle/aborted/limited is NOT evidence that a task completed.
    paint(ctx);
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== ownerId || !view.focused) return;
    view.blur();
    paint(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== ownerId) return;
    try {
      unsubscribeInput?.();
      unsubscribeInput = undefined;
      view.blur();
      panelTui = undefined;
      if (ctx.mode === "tui") { ctx.ui.setWidget(KEY, undefined); ctx.ui.setStatus(KEY, undefined); }
    } finally { ownerId = undefined; }
  });

  pi.registerTool({
    name: "task_plan",
    label: "Task plan",
    description: "Session checklist. add: tasks with title and optional blockedBy IDs; update: changes by id; list; clear. Batch completion and next-task start. blocked needs a note. No project files.",
    promptSnippet: "Track multi-step progress in the session",
    promptGuidelines: [
      "Use task_plan for multi-step work, not trivial requests. Keep one task in_progress; batch status handoffs.",
      "Verify relevant results before marking completed. Keep failing/unfinished work open; task status is a report, not proof.",
    ],
    executionMode: "sequential",
    parameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Task-plan update cancelled");
      return change(params, ctx);
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `task_plan ${args.action ?? ""}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const content = result.content.find(block => block.type === "text");
      return new Text(theme.fg("muted", content?.type === "text" ? content.text : ""), 0, 0);
    },
  });

  function toggleCompleted(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== ownerId) return;
    view.toggleCompleted(current(ctx));
    paint(ctx);
  }

  function toggleFocus(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== ownerId || hidden) return;
    if (panelTui?.hasOverlay()) return;
    view.toggleFocus(current(ctx));
    paint(ctx);
  }

  function handlePanelInput(data: string, ctx: ExtensionContext) {
    if (!view.focused || ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== ownerId) return;
    // Do not interfere with nested overlays, even when they open and close before
    // a render. Native focus restoration resumes the same panel selection.
    if (panelTui?.hasOverlay()) return;
    if (isKeyRelease(data)) return { consume: true };
    // Leave the registered shortcut to toggle once, after raw input listeners.
    if (matchesKey(data, Key.ctrlShift("t"))) return;
    try {
      const state = current(ctx);
      if (matchesKey(data, Key.escape) || (data !== "\n" && matchesKey(data, Key.enter))) view.blur();
      else if (matchesKey(data, Key.up)) view.move(state, -1);
      else if (matchesKey(data, Key.down)) view.move(state, 1);
      else if (matchesKey(data, Key.left)) view.fold(state, true);
      else if (matchesKey(data, Key.right)) view.fold(state, false);
      else {
        // Typing, pasting and agent controls return to the prompt unchanged.
        view.blur();
        paint(ctx);
        return;
      }
      paint(ctx);
      return { consume: true };
    } catch {
      view.blur();
      paint(ctx);
    }
  }

  pi.registerShortcut(Key.ctrlShift("t"), {
    description: "Focus/unfocus the task panel (arrows navigate, Esc returns to prompt)",
    handler: toggleFocus,
  });

  pi.registerCommand("task-plan", {
    description: "Inspect task plan: /task-plan [show|hide|focus|completed|clear]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const action = args.trim();
      if (action === "hide" || action === "show") {
        hidden = action === "hide";
        paint(ctx);
      } else if (action === "focus") {
        toggleFocus(ctx);
      } else if (action === "completed") {
        toggleCompleted(ctx);
      } else if (action === "clear") {
        view.blur();
        paint(ctx);
        if (!ctx.isIdle()) { ctx.ui.notify("Wait until the agent is idle before clearing its plan.", "warning"); return; }
        if (!(await ctx.ui.confirm("Clear task plan?", "This removes tasks on the current branch, not session history."))) return;
        if (!ctx.isIdle()) { ctx.ui.notify("Agent started; task plan was not cleared.", "warning"); return; }
        change({ action: "clear" }, ctx);
        checkpoint(ctx);
      } else if (!action) {
        ctx.ui.notify(listing(current(ctx)), "info");
      } else {
        ctx.ui.notify("Usage: /task-plan [show|hide|focus|completed|clear]", "warning");
      }
    },
  });
}
