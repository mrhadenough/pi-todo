// Pure state machine. No filesystem, model calls, timers, or process globals.
export const STATE_TYPE = "ccc.task-plan.v1";
export const STORAGE_ERROR_TYPE = "ccc.task-plan.storage-failed.v1";
export const MAX_TASKS = 50;
export const STATUSES = ["pending", "in_progress", "blocked", "completed"];
const LIMITS = { title: 160, note: 300 };
const STATUS_SYMBOLS = {
  pending: "☐",
  in_progress: "◐",
  blocked: "✕",
  completed: "☑",
};

export function emptyState() {
  return { version: 1, revision: 0, nextId: 1, tasks: [] };
}

function integer(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function text(value, field, required = false) {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  // Strip terminal control sequences, including OSC links and ANSI styling.
  const clean = value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .trim();
  if ((required && !clean) || clean.length > LIMITS[field]) {
    throw new Error(
      `${field} must be ${required ? "1" : "0"}-${LIMITS[field]} characters`,
    );
  }
  return clean;
}

export function validateState(state) {
  if (
    !state ||
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !integer(state.nextId) ||
    !Array.isArray(state.tasks) ||
    state.tasks.length > MAX_TASKS
  ) {
    throw new Error(
      "Invalid task-plan snapshot; do not restore an older status silently",
    );
  }
  const ids = new Set();
  for (const task of state.tasks) {
    if (
      !task ||
      !integer(task.id) ||
      ids.has(task.id) ||
      task.id >= state.nextId ||
      !STATUSES.includes(task.status) ||
      !Array.isArray(task.blockedBy) ||
      text(task.title, "title", true) !== task.title ||
      text(task.note, "note") !== task.note
    ) {
      throw new Error("Invalid task-plan task");
    }
    ids.add(task.id);
  }
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  let active = 0;
  for (const task of state.tasks) {
    if (task.status === "in_progress") active++;
    if (
      new Set(task.blockedBy).size !== task.blockedBy.length ||
      task.blockedBy.some(
        (id) => !integer(id) || id === task.id || !byId.has(id),
      )
    ) {
      throw new Error(`Invalid dependencies for #${task.id}`);
    }
    if (
      ["in_progress", "completed"].includes(task.status) &&
      task.blockedBy.some((id) => byId.get(id).status !== "completed")
    ) {
      throw new Error(`#${task.id} has unfinished dependencies`);
    }
    if (task.status === "blocked" && !task.note)
      throw new Error(`Blocked #${task.id} needs a reason in note`);
  }
  if (active > 1)
    throw new Error(
      "Only one task may be in_progress; batch completion and handoff together",
    );
  const visiting = new Set(),
    visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("Task dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).blockedBy) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  return state;
}

export function replay(branch) {
  let latest;
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === STORAGE_ERROR_TYPE) {
      throw new Error(
        "Task-plan storage failed. Fix storage and reopen the saved session, or branch before the failure.",
      );
    }
    if (entry.type === "custom" && entry.customType === STATE_TYPE)
      latest = entry;
  }
  // A corrupt latest snapshot is an error, not permission to show stale success.
  return latest ? structuredClone(validateState(latest.data)) : emptyState();
}

export function counts(state) {
  const result = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    completed: 0,
    total: state.tasks.length,
  };
  for (const task of state.tasks) result[task.status]++;
  return result;
}

export function summary(state) {
  const n = counts(state);
  return `Plan r${state.revision}: ${n.completed}/${n.total} completed, ${n.in_progress} in_progress, ${n.blocked} blocked, ${n.pending} pending`;
}

export function taskLine(task) {
  const dependencies = task.blockedBy.length
    ? ` (after ${task.blockedBy.join(",")})`
    : "";
  return `${task.id}. ${STATUS_SYMBOLS[task.status]} ${task.title}${dependencies}${task.note ? ` — ${task.note}` : ""}`;
}

export function listing(state) {
  return (
    summary(state) +
    (state.tasks.length
      ? "\n" + state.tasks.map(taskLine).join("\n")
      : "\nNo tasks.")
  );
}

export function apply(state, params) {
  validateState(state);
  const next = structuredClone(state);
  const changed = [];
  switch (params.action) {
    case "list":
      if (params.tasks !== undefined || params.changes !== undefined)
        throw new Error("list takes no tasks or changes");
      return { state, changed, mutated: false, content: listing(state) };
    case "add": {
      if (
        !Array.isArray(params.tasks) ||
        !params.tasks.length ||
        params.changes !== undefined
      ) {
        throw new Error("add requires tasks only");
      }
      if (next.tasks.length + params.tasks.length > MAX_TASKS)
        throw new Error(`At most ${MAX_TASKS} tasks; clear the old plan first`);
      for (const item of params.tasks) {
        const task = {
          id: next.nextId++,
          title: text(item.title, "title", true),
          status: "pending",
          blockedBy:
            item.blockedBy === undefined ? [] : structuredClone(item.blockedBy),
          note: "",
        };
        next.tasks.push(task);
        changed.push(task.id);
      }
      break;
    }
    case "update": {
      if (
        !Array.isArray(params.changes) ||
        !params.changes.length ||
        params.tasks !== undefined
      ) {
        throw new Error("update requires changes only");
      }
      const seen = new Set();
      for (const patch of params.changes) {
        const task = next.tasks.find((item) => item.id === patch.id);
        if (!task || seen.has(patch.id))
          throw new Error(`Unknown or duplicate task #${patch.id}`);
        seen.add(patch.id);
        if (
          !["title", "status", "blockedBy", "note"].some(
            (key) => patch[key] !== undefined,
          )
        ) {
          throw new Error(`No changes provided for #${patch.id}`);
        }
        if (patch.title !== undefined)
          task.title = text(patch.title, "title", true);
        if (patch.status !== undefined) {
          if (patch.status !== task.status) task.note = ""; // Do not carry an obsolete blocker into completion.
          task.status = patch.status;
        }
        if (patch.blockedBy !== undefined)
          task.blockedBy = structuredClone(patch.blockedBy);
        if (patch.note !== undefined) task.note = text(patch.note, "note");
        changed.push(task.id);
      }
      break;
    }
    case "clear":
      if (params.tasks !== undefined || params.changes !== undefined)
        throw new Error("clear takes no tasks or changes");
      next.tasks = []; // Keep nextId: late updates cannot accidentally address a new task.
      break;
    default:
      throw new Error("Expected action add, update, list, or clear");
  }
  validateState(next); // Validate the entire atomic batch, not transient intermediate states.
  const mutated = JSON.stringify(next.tasks) !== JSON.stringify(state.tasks);
  if (mutated) next.revision++;
  validateState(next);
  const rows = changed.map((id) => next.tasks.find((task) => task.id === id));
  const content =
    summary(next) +
    (!mutated
      ? "\nNo change."
      : params.action === "add"
        ? "\n" + rows.map(taskLine).join("\n")
        : params.action === "clear"
          ? "\nCleared."
          : "\n" + rows.map((task) => `${task.id}. ${task.status}`).join("; "));
  return { state: next, changed, mutated, content };
}

// Collapsed content is bounded; explicit expansion adds completed rows without displacing open work.
export function panel(state, busy, maxRows = 5, completedCollapsed = true) {
  const n = counts(state);
  if (!n.total) return [];
  const pending = state.tasks.filter((task) => task.status === "pending");
  const open = [
    ...state.tasks.filter((task) => task.status === "in_progress"),
    ...pending.slice(0, 2), // Keep the next two upcoming tasks visible, even with blockers.
    ...state.tasks.filter((task) => task.status === "blocked"),
    ...pending.slice(2),
  ];
  const completed = state.tasks.filter((task) => task.status === "completed");
  // Reserve the same compact layout for open work in either view. Explicit expansion
  // adds every completed row outside this budget so the toggle always reveals them.
  const available = maxRows - (completed.length ? 1 : 0);
  const taskLimit = Math.max(0, available - (open.length > available ? 1 : 0));
  const visible = open.slice(0, taskLimit);
  const hidden = open.slice(taskLimit);
  const taskRow = (task) => ({
    id: task.id,
    status: task.status,
    text: taskLine(task),
  });
  const rows = [
    {
      status: "header",
      text: `Tasks ${n.completed}/${n.total} reported complete · agent ${busy ? "busy" : "idle"}`,
    },
  ];
  if (completed.length) {
    rows.push({
      status: "completed_toggle",
      text: `${completedCollapsed ? "▸" : "▾"} ${n.completed} completed task${n.completed === 1 ? "" : "s"} · Ctrl+Shift+T to focus`,
    });
    if (!completedCollapsed) rows.push(...completed.map(taskRow));
  }
  rows.push(...visible.map(taskRow));
  if (hidden.length) {
    const labels = {
      in_progress: "in progress",
      blocked: "blocked",
      pending: "pending",
    };
    const overflow = ["in_progress", "blocked", "pending"].flatMap((status) => {
      const count = hidden.filter((task) => task.status === status).length;
      return count ? [`${count} ${labels[status]}`] : [];
    });
    const text = hidden.every((task) => task.status === "pending")
      ? `${hidden.length} more pending tasks`
      : `More: ${overflow.join(", ")}`;
    rows.push({ status: "overflow", text: `▸ ${text} — /task-plan for all` });
  }
  return rows;
}
