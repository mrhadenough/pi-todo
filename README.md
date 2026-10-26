# pi-todo

A compact task checklist for the [Pi coding agent](https://pi.dev), with keyboard
navigation, dependencies, and branch-aware session persistence.

- One `task_plan` tool to add, update, list, and clear tasks.
- A terminal panel that keeps current and upcoming work visible.
- Plans restored on reload, resume, and branch navigation.
- No build step, extra model calls, background workers, or project task files.

## Install

Requires **Node.js 22.19+** and an installed Pi. Tested with **Pi 1.3.0**;
compatibility with other Pi versions is not guaranteed.

Install directly from GitHub—no manual clone or npm publication is needed:

```sh
pi install git:github.com/mrhadenough/pi-todo
```

Restart Pi, or run `/reload` in an existing session, then run `/task-plan` to
confirm it loaded. Pi manages the checkout for you.

To install only for a particular project, run this from that project's root:

```sh
pi install --local git:github.com/mrhadenough/pi-todo
```

Project packages load after Pi's project-trust approval. To try the extension
without saving an installation:

```sh
pi -ne -e git:github.com/mrhadenough/pi-todo
```

`-ne` disables other extensions for that invocation. **Load only one extension
registering `task_plan` or `/task-plan`**; use `pi config` to disable duplicates.

### From npm

This package is **not published yet**. Once a release is available, install it
with `pi install npm:@mrhadenough/pi-todo`.
The manifest keeps `private: true` until publication is approved. The npm scope
must be confirmed before release. See [Publishing](PUBLISHING.md) for release checks.

The project name is `pi-todo`; the `task_plan` tool, `/task-plan` command, and
session-storage identifiers are unchanged so existing usage and saved plans remain
compatible.

## Use

Ask Pi:

> Track this work with task_plan. Inspect the issue, implement the fix, and verify it before marking tasks complete.

```text
Tasks 3/10 reported complete · agent busy
▸ 3 completed tasks · Ctrl+Shift+T to focus
4. ◐ Current task
5. ☐ Next task
6. ☐ Following task
▸ 4 more pending tasks — /task-plan for all
```

Tasks are **☐ pending**, **◐ in progress**, **✕ blocked**, or **☑ completed**.
The collapsed panel uses at most five content rows plus its heading, prioritizing
the current task and next two pending tasks. Completed tasks are folded by default.

| Command / key | Action |
| --- | --- |
| `/task-plan` | Show the full list |
| `/task-plan hide` / `show` | Hide or show the panel |
| **Ctrl+Shift+T** or `/task-plan focus` | Focus or unfocus the panel |
| **↑ / ↓**, while focused | Select rows and scroll |
| **← / →**, while focused | Collapse or expand the completed group |
| **Esc / Enter**, while focused | Return to the prompt without aborting or submitting |
| `/task-plan completed` | Toggle completed rows |
| `/task-plan clear` | Clear this branch's list; requires an idle agent and confirmation |

Typing or pasting while focused returns input to the prompt. Native overlays keep
input ownership. If your terminal cannot distinguish Ctrl+Shift+T, use
`/task-plan focus`. Navigation and folding never change task statuses.

## Tool interface

These are model tool calls, not shell or slash commands:

```js
task_plan({action: "add", tasks: [
  {title: "Inspect the issue"},
  {title: "Verify the fix", blockedBy: [1]}
]})
task_plan({action: "update", changes: [{id: 1, status: "in_progress"}]})
task_plan({action: "update", changes: [
  {id: 1, status: "completed", note: "Regression test passed"},
  {id: 2, status: "in_progress"}
]})
task_plan({action: "list"})
```

Use returned IDs; this example assumes a fresh list. Clearing never resets the ID
counter. Updates accept `title`, `status`, `blockedBy`, and `note`. Only one task
may be in progress, blocked tasks require a reason, and dependencies must be
completed before a task starts or completes. Batches validate atomically.

Limits: 50 tasks, 160 characters per title, 300 per note. Status changes clear old
notes unless replaced. Tool-issued `clear` does not prompt for confirmation.

## Persistence and privacy

- **Completion is model-reported, not independently verified.** Idle, aborts, or
  unrelated passing commands never complete tasks automatically.
- Plans live in Pi's session history and follow the active branch. `--no-session`
  is ephemeral. Uninstalling does not erase historical session entries.
- After compaction, one checkpoint restores task context. Ordinary turns do not
  repeatedly inject the list or trigger automatic continuation.
- Task titles and notes may reach your configured model provider. Do not include
  secrets. Extensions run with Pi's permissions; review source before installing.
- Corrupt state and storage failures fail closed. After fixing a storage failure,
  **reopen the saved session**, rather than only running `/reload`. If a failure
  marker was persisted, branch before it or start a fresh session.

## Update or remove

Update the GitHub installation, then reload Pi:

```sh
pi update git:github.com/mrhadenough/pi-todo
```

Remove it with:

```sh
pi remove git:github.com/mrhadenough/pi-todo
```

Add `--local` when removing a project-scoped installation from that project.

## Development

```sh
npm test
npm run test:sdk
npm run test:package
```

The SDK checks require an installed Pi package; a missing SDK fails rather than
skipping. Automated rendering tests do not replace real-terminal visual QA.

See [Contributing](CONTRIBUTING.md), [Design](docs/DESIGN.md), and
[Testing](docs/TESTING.md) for details.

## License

[MIT](LICENSE).
