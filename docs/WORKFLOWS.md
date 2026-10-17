# Workflows

Workflows automate work across chats, agents, accounts and computers (requested 2026-10-16). They come in two modes, shown in the same 2D graph:

- A **static workflow** is a graph of steps you or an agent draw and edit, like n8n or Make: start a chat with an agent, send a message to a chat, read a chat's history, branch on a condition, loop over items, wait, ask you, notify you, set values, build or use a screen, run another workflow. Each run follows the graph.
- A **mission** (a dynamic workflow) gives an orchestrator agent a goal. The orchestrator plans, spawns agents on the computers and accounts it chooses, reviews their work, asks you when it needs to, keeps shared notes and drives the work until the mission is complete, over as many sessions, computers and days as it takes. Its plan and every agent it starts appear live in the graph.

Both keep a history of what happened. The **Workflows** tab of the sidebar, beside Active, History and Screens, lists missions and runs in progress, saved workflows and finished runs. There is no slash command, since Claude Code's own `/workflows` is a different feature.

These are Agent Studio's own workflows. Claude Code's native Dynamic Workflows (its `Workflow` tool, run inside one Claude chat) are unrelated and work as before ([CAPABILITIES.md](CAPABILITIES.md)).

## Static workflows

**New workflow** opens the editor with a Start step. Add steps from **Add step**, drag them, and connect an output port to the next step's input. Selecting a step opens its settings beside the graph; **Workflow** settings hold the name, description, start inputs and schedules. **Save** keeps the definition; **Run** asks for the start inputs and the computer that runs it.

Steps (`src/lib/workflow-model.ts`, `nodeTypes`):

| Step          | What it does                                                                                                                                                                                                                                                                                       | Outputs     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Start         | Where a run begins, with its inputs (name, label, default, multiline) and optional schedules.                                                                                                                                                                                                      | out         |
| Agent         | Starts a chat on a computer and folder (or Standalone) with an agent, account (or the least used one), model and reasoning, sends the prompt and waits for the reply. Optionally asks for a JSON reply. A repeated run of the step continues its chat for the same loop item, or starts a new one. | out, error  |
| Message       | Sends a message to the chat of an earlier step or to a chosen chat: as its next message (queued while a reply runs) or as a steer of its running reply. Waits for the reply unless told not to.                                                                                                    | out, error  |
| Read chat     | Reads the latest reply, the last messages or the whole conversation of a chat.                                                                                                                                                                                                                     | out, error  |
| Condition     | Compares two values (contains, equals, matches a pattern, greater or less than, empty, true).                                                                                                                                                                                                      | true, false |
| Loop          | Runs the steps after **each** once per item of a list (a JSON array or lines), one after another or all at once, then continues from **done**.                                                                                                                                                     | each, done  |
| Merge         | Waits for every incoming branch of the same run and loop item, then continues once.                                                                                                                                                                                                                | out         |
| Wait          | Waits for a duration or until a time.                                                                                                                                                                                                                                                              | out         |
| Ask           | Asks you a question, with optional choices, and continues with the answer.                                                                                                                                                                                                                         | out         |
| Notify        | Sends a notification.                                                                                                                                                                                                                                                                              | out         |
| Set           | Computes named values from templates, optionally parsed as JSON.                                                                                                                                                                                                                                   | out         |
| Screen        | An agent step that builds or updates a screen with `save_screen`.                                                                                                                                                                                                                                  | out, error  |
| Screen action | Runs an allowed action of a screen on its computer.                                                                                                                                                                                                                                                | out, error  |
| Screen data   | Loads or saves a value of a screen's data.                                                                                                                                                                                                                                                         | out, error  |
| Run workflow  | Runs another saved workflow and continues with its output.                                                                                                                                                                                                                                         | out, error  |
| End           | Ends the run with an output, completed or failed.                                                                                                                                                                                                                                                  | —           |

A step's text fields are templates: `{{input.topic}}` is a start input, `{{research.output}}` the output of the step whose key is `research`, `{{research.json.items}}` a part of its JSON, `{{research.chat}}` its chat's id, `{{item}}` and `{{index}}` the current loop item, `{{previous.output}}` what the step before handed over, and `{{run.title}}`, `{{now}}`. The step settings list what is available. Each step has a key (letters, digits and `_`), unique in its workflow.

When a step fails, its **If it fails** setting stops the run, continues as if it succeeded, or follows its **error** port (also taken whenever that port is connected), after the retries it allows. An interrupted reply (the app closed, its computer went away) and a reply stopped at a usage limit never count as failures: the step waits and runs again.

Runs follow the graph as tokens: when a step ends it hands its output to each step its chosen port connects to, and every such hand-over runs that step once, so several outgoing connections run branches in parallel and a connection back to an earlier step repeats it (a review loop). A Merge step joins branches. A loop item ends when nothing of it is still queued, running or waiting, so its steps need no connection back to the loop. A run completes when nothing is left to do, and fails when a step that stops the run fails.

A run keeps a copy of the definition it started with, so editing a workflow never changes runs already going. Schedules (every N minutes or hours, daily at a time, weekly on chosen days, in the editor's time zone) start runs on the computer the workflow names, or on a server when it is offline. Each slot's run has an id derived from the workflow, schedule and time, so two computers never start the same slot twice; a computer that was off starts the latest missed slot once, when it is less than a day old. A deleted run stays deleted: the store never accepts its id again.

## Missions

**New mission** asks for the mission, a title, an optional project folder on a computer, the orchestrator's agent, account, model and reasoning, and the computer that drives it. Starting it creates an orchestrator chat on the driving computer with the mission brief, and from then on the orchestrator manages everything through its mission tools:

- `mission_state` returns the mission, the plan, every agent and its status and result, the notes, open questions, timers, the computers with their online state and folders, and every account with its 5-hour and weekly usage, pace and resets.
- `mission_plan` adds, changes or removes plan tasks (title, description, status, dependencies, phase), which the graph shows live.
- `mission_spawn` starts an agent: a new chat with its task, on the computer, folder, agent, account, model and reasoning it chooses (the least used account when it names none), with the mission and notes included unless told otherwise. It returns at once; the agent may wait for its computer, sign-in or usage first.
- `mission_message` sends a chat (an agent's or any other) its next message or a steer; `mission_stop` stops a chat's reply; `mission_read` reads its latest reply, last messages or whole history; `mission_chats` lists the workspace's chats.
- `mission_ask` asks you questions without blocking: other work goes on, and your answer arrives as an event.
- `mission_note` writes, changes or deletes shared notes: decisions, conventions, progress, learnings. Notes outlive sessions and are how any later session or agent continues.
- `mission_wait` sets a timer, such as a usage reset.
- `mission_screen` runs an allowed screen action or loads or saves a screen's data; the orchestrator also has `save_screen` for its own screens.
- `mission_run_workflow` runs a static workflow; `mission_complete` ends the mission with a summary.

The orchestrator works in turns. After starting work it ends its turn, and the engine wakes it with a message listing what happened since (an agent finished, with its reply; an answer arrived; a timer fired; a computer went offline or came back; a usage limit reset; you wrote a note or resumed the mission). A turn that leaves nothing running, waiting or scheduled is followed by a reminder, at growing intervals, so a mission never just stops. Its instructions ask for the most complete, professional result: plan, iterate with separate reviewers, never shortcut, use time freely, and pace by the accounts' limits, slowing down near them but never stopping because of them.

The graph shows the orchestrator, each plan task with its dependencies, and inside each task the agents that worked on it, each with its status and what it is doing now (Running `npm test`, Writing, Thinking), read from its chat. Questions and timers appear beside the orchestrator. Selecting an agent opens its details; opening it shows its chat.

## Chats a workflow creates

Every chat a workflow starts is an ordinary conversation on its computer: it syncs, its reply runs and is saved as any other, and you can open it from the graph, read it and type into it (a message of yours never completes the step that started the chat). Workflow chats stay out of the Active and History lists, the pending badge and chat alerts, unless an Agent step lists them; the run names them (`conversations` in its summary). A chat a workflow opened shows **Workflow · title** above it, which returns to the graph. A worker's process is released when its reply ends, since a mission may start hundreds, and an orchestrator's once the reply that ended its session or mission ends; the next message resumes its native session. A finished run lists each of its chats as done, failed or stopped.

Deleting a finished run can delete its chats too.

## Usage and limits

Before a step or mission agent starts a reply, the engine checks the account: a 5-hour or weekly limit at 100%, or a refusal at a usage limit, makes it wait until the reset the account reports (re-reading the account, and again every 15 minutes while no reading tells), then go on. An account that needs sign-in, or a computer that is offline, makes it wait and say so. Without a chosen account, the step takes the least used ready account of that agent on that computer (`src/lib/account-balance.ts`), and an exhausted one gives way to another with room. The orchestrator's own account works the same way: at a limit it waits, or continues with another account of its agent on the driving computer that has room.

Nothing in a workflow is capped by count, size or time: steps, agents, loops, notes, history and runs may grow as the work needs, and a run goes on until it ends or you stop it.

## Where workflows live

Definitions and runs are documents in the **workflow store**, never in the workspace: a run changes every few seconds while it works and its history grows for days, and the workspace syncs as one document. The store keeps each document with a revision, an append-only history per run, and the lease of the computer driving each run (`src/lib/workflow-store.ts`):

- Paired with a relay that has the store (its revision answer says `workflows`), every device reads and writes it there (`relay/workflows.ts`: `POST v1/workflows/list`, `POST v1/workflows/read`, `PUT v1/workflows/<id>`, `POST v1/workflows/<id>/delete`, `POST v1/workflows/<id>/lease`), under the workspace's own data directory, so it is shared across computers and reachable while any one of them is off. A change bumps the store revision the relay's poll already reports, so other devices notice it without another request.
- Unpaired, or paired with a relay without the store, a desktop keeps its own store in app data `workflows/` through native file commands, and moves its documents up once it meets a relay with the store. The Viewer needs the relay's store, so a relay released before workflows shows the Viewer none, and runs stay on the computer that started them until the relay is updated.

Writes are compare-and-set on the document's revision. A conflicting write merges both sides (`mergeRun`): commands, questions, notes, tasks, agents and steps by id, each by its own revision, so the driver's progress, your answers, commands and notes never overwrite each other. A definition saved over a newer revision is refused, and the editor offers to reload it or save a copy.

## Which computer drives a run

One desktop page (a desktop app or a server host, never the Viewer) drives each active run: it holds the run's lease, renewed every 15 seconds for 60, and executes it. The run names a preferred computer (where it was started, or the one you chose) and whether it may continue elsewhere (on by default). When the driver's lease lapses (the computer slept, closed or lost its connection) and the preferred computer is offline, another desktop claims it, servers first, others 30 seconds later; after two minutes without a driver any eligible desktop claims it. The new driver reconciles the run from what it can see (each step's and agent's chat, its reply's status), continues waits and timers, and for a mission starts a new orchestrator session on its own computer, briefed with the mission, plan, agents, notes, questions and recent history. Agents keep running where they run; replies another computer runs go on without the computer that requested them. A driver that cannot renew its lease stops starting work until it can, so two computers never drive one run.

## Agent tools

Every Claude and Codex chat with tools gets the workflow tools, Claude through the `agent_studio` SDK server (`mcp__agent_studio__workflow_save`, …) and Codex as dynamic tools (`src-tauri/src/providers/workflow_calls.rs`): `workflow_list`, `workflow_read`, `workflow_save` (create or replace a definition: nodes, edges, inputs; the description documents every step), `workflow_run`, `workflow_status` and `mission_start`. An orchestrator chat also gets the mission tools above. Only the conversation's own call reaches them (Claude's registered parent tool use, Codex's parent thread without a namespace).

The executing computer's own page answers them: the host sends each call to its window (`studio-workflow-call`), the page acts through the store and the engine, and `answer_workflow_call` returns the result to the CLI, as an answered question does. A reloaded page picks up calls still waiting (`pending_workflow_calls`); a reply that ends leaves its waiting calls unanswered and refuses late answers. Mission tools answer only the current orchestrator of a run this page drives; another session hears where the mission continues. A run request names its mission role (`mission`: the run and `orchestrator`), which is part of the parked-process identity, since it changes the tools.

## Notifications

A question of a run, a Notify step and a run's end alert you once on each desktop (device-local receipts) and on paired phones through the relay, with the workflow's title and one line. Chat alerts of workflow chats stay quiet; a question a worker asks in its own chat still alerts.

## Verification

See [VERIFICATION.md](VERIFICATION.md).
