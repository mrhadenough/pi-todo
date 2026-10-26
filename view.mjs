import { panel } from "./state.mjs";

// Terminal-only state: never persisted or included in the model's task snapshot.
export class TaskPanelView {
  focused = false;
  completedCollapsed = true;
  selectedKey;
  top = 0;

  reset() {
    this.focused = false;
    this.completedCollapsed = true;
    this.selectedKey = undefined;
    this.top = 0;
  }

  blur() {
    this.focused = false;
  }

  items(state) {
    // At most 50 tasks plus the completed group: no preview overflow here.
    return panel(state, false, state.tasks.length + 1, this.completedCollapsed)
      .slice(1)
      .map((row) => ({
        ...row,
        key: row.status === "completed_toggle" ? "completed" : `task:${row.id}`,
      }));
  }

  reconcile(state) {
    const items = this.items(state);
    if (!items.length) {
      this.blur();
      this.selectedKey = undefined;
      this.top = 0;
    } else if (!items.some((row) => row.key === this.selectedKey)) {
      this.selectedKey = items[0].key;
    }
    return items;
  }

  toggleFocus(state) {
    if (this.focused) this.blur();
    else if (this.reconcile(state).length) this.focused = true;
  }

  move(state, delta) {
    const items = this.reconcile(state);
    if (!items.length) return;
    const index = items.findIndex((row) => row.key === this.selectedKey);
    this.selectedKey =
      items[Math.max(0, Math.min(items.length - 1, index + delta))].key;
  }

  fold(state, collapsed) {
    const selected = this.reconcile(state).find(
      (row) => row.key === this.selectedKey,
    );
    if (
      selected?.status !== "completed_toggle" &&
      !(collapsed && selected?.status === "completed")
    )
      return;
    this.completedCollapsed = collapsed;
    this.selectedKey = "completed";
  }

  toggleCompleted(state) {
    if (!state.tasks.some((task) => task.status === "completed")) return;
    this.completedCollapsed = !this.completedCollapsed;
    this.reconcile(state);
  }

  rows(state, busy, maxRows = 5, active = true) {
    const items = this.reconcile(state);
    if (!this.focused || !active)
      return panel(state, busy, maxRows, this.completedCollapsed);
    const index = items.findIndex((row) => row.key === this.selectedKey);
    if (index < this.top) this.top = index;
    if (index >= this.top + maxRows) this.top = index - maxRows + 1;
    this.top = Math.max(0, Math.min(this.top, items.length - maxRows));
    const end = Math.min(items.length, this.top + maxRows);
    const header = panel(state, busy, maxRows, this.completedCollapsed)[0];
    return [
      {
        ...header,
        text: `Tasks [focused ↑↓ ←→ Esc] ${header.text.slice(6)} · rows ${this.top + 1}–${end}/${items.length}`,
      },
      ...items.slice(this.top, end).map((row) => ({
        ...row,
        selected: row.key === this.selectedKey,
        text: `${row.key === this.selectedKey ? "› " : "  "}${row.status === "completed_toggle" ? row.text.split(" · ")[0] : row.text}`,
      })),
    ];
  }
}
