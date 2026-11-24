# Reserving the computer for a measurement

Chats run side by side on a computer, and that stays the default: builds, tests, game runs and
editors of several chats run together. A performance measurement is the exception. A benchmark,
a profiling run or a timing test is worthless when another chat starts an Unreal build or a game
in the middle of it, which used to make chats throw their results away (requested 2026-11-24).
So a chat that measures reserves the computer first, and the reservation is a real place in line:
from the moment a chat asks, no other chat starts a command, so the wait never depends on the
computer getting quiet by itself, which never happens while several chats work.

The native broker is `src-tauri/src/reservations.rs`, with `reservations/tools.rs` (the agents'
tools and the gate), `reservations/light.rs` (light commands), `reservations/machine.rs`
(measuring the computer), `reservations/jobs.rs` (which chat a process belongs to) and
`reservations/programs.rs` (programs chats left running, and stopping them). Every
Windows chat and the WSL distributions this computer manages share one broker, since they share
the computer.

## How a measurement goes

1. **Prepare.** The agent builds, cooks and finishes its own background work first, and calls
   `pc_status`, which lists what other chats run, the programs chats left running, the busiest
   and largest programs and whose they are: a chat's, Agent Studio's, the system's, or the user's
   own. Programs the user started are the only thing an agent asks the user about, with
   `studio_ask_user` (close them, or measure anyway), and it asks before reserving, so no other
   chat waits on the answer. What chats left running it handles itself (below).
2. **Reserve.** `pc_reserve` with a purpose and, optionally, the minutes the measurement takes.
   From that moment other chats' new commands wait, except light ones. The answer lists what
   still runs.
3. **Wait for the window.** `pc_wait` returns once no other chat runs a command, nor background
   work that a reply of its own still runs and waits on, nor holds what it was asked to hand over.
   Background work and programs a chat left running after its reply ended (a dev server, an
   editor) do not keep the window closed; they are listed, with the programs other chats left
   running, so that the agent can stop them first, and they show in the report.
4. **Measure** at once: warm up, run several times.
5. **Release** with `pc_release` right after capturing, and analyze afterwards. The answer is the
   report. A reservation also ends by itself when the reply that made it ends.

Reservations take turns, first come first served: the first holds the computer, the others wait
in line, and their own chats' commands wait for the first like everyone else's. A chat that
reserves again only updates its purpose and estimate. Nothing is capped: a reservation, a wait
and a queue last as long as their chats need; a reservation ends only when its chat releases it
or its reply ends.

## What waits, and how

- **Claude chats.** Each chat process registers a `PreToolUse` hook callback for `Bash`,
  `PowerShell` and `Monitor` in its `initialize` request, beside the compaction hooks. The
  running reply answers it: with no opinion when the computer is free, the command is light, or
  the chat holds the reservation itself (its sub-agents included); otherwise with a refusal that
  names the chat measuring and its purpose and tells the agent to call `pc_wait` and run the
  command again. A refusal rather than a held answer: a process parked between replies has nobody
  to answer its hooks, so the hook's timeout is 30 seconds, and a command an unobserved turn of a
  parked process starts goes ahead after it. Claude Code names an SDK callback
  `PreToolUse:Callback`, which Work history leaves out. It also reports a call as started before
  it asks the gate, so a call the gate refused counts for nothing: it never keeps a window closed
  nor shows in a report as work that ran.
- **Light commands** run anyway (`light.rs`): reading files, listing folders, searching text and
  asking Git about the checkout, every part of the command line. A command substitution, a script
  block, `Invoke-Expression` or any program the list does not name makes the command wait.
- **Codex chats** on Windows get the same refusal (`reservations/codex_gate.rs`, found
  2026-11-24 on Codex 0.172). Codex runs `preToolUse` hooks before a shell command (its tool is
  `Bash` to hooks, as in Claude Code) and blocks it when one answers `permissionDecision: deny`
  with a reason. Each Codex chat's app-server starts with such a hook given as a session flag,
  `-c hooks.PreToolUse=[...]`, which Codex adds to the user's own hooks: this app's program in
  its gate mode (`--pc-gate`), run as PowerShell runs a quoted path (`& '…' --pc-gate`; Codex
  runs hook commands through PowerShell, and a hook that fails lets its command run). The gate
  reads the hook's input, asks the running app over a named pipe whether the chat may run the
  command (the pipe's name and the chat's id reach it in the app-server's environment), and
  prints Codex's refusal when it may not. Codex runs a session-flag hook only once it is
  trusted by a hash of its definition, which it does not document: once per Codex executable
  and gate command, an app-server started with the hook and no thread lists its hooks
  (`hooks/list`), and the key and hash it reports go with every launch after
  (`-c hooks.state={<key> = {trusted_hash = …}}`, merged with the user's own trust entries),
  kept in memory and in app data `reservations/codex-gate.json`. Work history shows the gate
  only when it blocks a command. `thread/start`'s `config` does not register hooks, and the
  `untrusted` approval mode, whose requests the app could have held, is gone from Codex 0.172.
  WSL distributions run their hooks through another shell and have no pipe to this app, so a
  WSL Codex chat's commands are not held yet: one that runs during a window is in the report.
- **What runs** is what the replies running on this computer report: each command and monitor
  from its start until it ends (`Broker::tool`, fed by every chat run's events), and the
  background work chats' CLIs keep (`background_work`). A command is named, and judged light, as
  its agent wrote it: lines a CLI hook put before it, running a script under a `hooks` folder,
  are left out, as the window's `primaryCommand` leaves them out (a user's Codex `PreToolUse`
  hook may prepend one to every command, which made every Codex command read as that line).

`pc_wait` waits as long as the computer stays reserved. Its answer, like every answer of these
tools, goes back to the CLI through the run's own channel (`Session::rx`), so a long wait never
holds up the reply's loop, and Stop ends it.

## Coordinating with other chats

Agents coordinate by themselves, so the user is asked only about the user's own programs
(requested 2026-11-24).

- **Messages.** `chat_message` writes to another chat that is replying on this computer. It reads
  the message with its next tool call: in a Claude chat, a `PostToolUse` hook callback that every
  chat process registers beside the gate answers with the message as `additionalContext` (10
  seconds' timeout, for the same reason as the gate's); in a Codex chat, the gate before its
  next command does (`codex_gate`, `additionalContext` beside a command it lets run, which
  Codex 0.172 hands the model); and in either, the answer of any of these tools, a message
  ending a `pc_wait` early. Only the chat's own agent reads it, never a sub-agent: Claude names a
  sub-agent's calls with `agent_id`, and a Codex sub-agent works in a thread of its own, which
  the gate compares with the chat's. The reply shows it in its Work history as a record of its
  own, Message from another chat, with the text in its details. A chat that is not replying
  cannot read one, so the sender is told at once, and a message its reader's reply ended before
  reading goes back to its sender as a notice. Codex refuses a steer without input, so no message
  reaches a chat as the user's.
- **Handing over.** A chat may still need something the measurement waits for, such as an editor
  it works with. Rather than waiting for its whole reply, the chat holding the computer asks it
  with `chat_message` and `hand_over`: that chat's commands run again while it finishes, and the
  window waits for it (an open window closes again, its readings dropped). It hands over with
  `pc_release`: Agent Studio closes the programs it left running, its commands wait like the
  others' from then on, and its background work no longer keeps the window closed. Its reply
  ending ends the ask too, closing nothing, and a chat that read an ask hears when the
  measurement no longer needs it.
- **Stopping.** `pc_stop` stops what a chat that is not replying left running, or the calling
  chat's own programs: the programs `pc_status` lists for it by number, and with `background`
  the background work its CLI keeps, by releasing that CLI as History does (its next reply starts
  it again). A replying chat is asked to hand over instead.

A **program** a chat left running is a process in its job outside its CLI's own process tree,
such as an editor or a server a command started and let go, grouped with the processes it started
under the topmost of them. Windows only: elsewhere a process that outlives its parent says nothing
of whose it was. A program with a window is asked to close as its close button asks
(`WM_CLOSE` to its shown top-level windows, a window another shown window owns closing with it),
so it may still ask about unsaved work, and it is waited for while it works on closing: one that
sits idle for 15 seconds may be asking something, and one still busy after two minutes is left to
finish, both reported so that the agent asks the user. What it leaves running without a window
then ends. A program without a window is ended. Every process is checked by when it began before
anything is sent to it, so a process that took another's id is never touched.

## Whose a process is

On Windows each chat CLI runs in a job object of its own (`jobs.rs`), which every process it starts
joins, an editor left open included, so a process is the chat's however it was started. Jobs limit
nothing: they let a process break away when it asks, never end their processes, and are dropped
once none of their processes runs. A process outside every job is Agent Studio's when the app
started it, the system's when it runs outside the signed-in session (Windows' services), and the
user's otherwise. WSL processes run inside the distribution's virtual machine and count as one
program on Windows. Linux server hosts tell processes apart by their parent chain.

## The report

`pc_release` returns, and `reservations/history.jsonl` in app data keeps one JSON line per
reservation:

- when the window opened after the reservation, and how long it stayed open;
- what kept it closed, each chat's command with how long it ran meanwhile, and the chats asked
  to hand over, with when they read the request and how and when it ended;
- what was stopped for it, and by which chat: a chat's stops go to the reservation it holds,
  or to the one it makes next in the same reply, since a chat clears the computer before it
  reserves as often as after;
- other chats' work that ran while it was open anyway (Codex commands, work left running);
- the computer while it was open, read every two seconds: CPU on average and at most, the
  measuring chat's processes apart from everything else, memory in use and free, and the busiest
  and largest other programs with whose they are;
- how long other chats waited in `pc_wait` because of it, split by what kept the window closed
  at the time (time several things shared is split between them), and how many commands waited.

A reply waiting in `pc_wait` counts that time as **Waiting for the computer** in its time ledger
(`held`, in the On hold family of the Time report).

## In the window

While the computer is reserved, a gauge in the sidebar's footer, beside Connections, names the
chat and its purpose on hover with where it stands (waiting for commands or for chats to hand
over, measuring, chats waiting, reservations in line) and opens that chat. It is in the warning colour while other
chats' work finishes and in the accent while the measurement runs. The window follows
reservations through `studio-pc` events and `pc_state`; nothing about them is saved or synced.
The Viewer shows none.

## Not yet

- Holding WSL Codex chats' commands (see above), and freezing a process a chat starts during a
  window when nothing else can hold it.
- Programs a WSL chat left running, which run inside the distribution's virtual machine.
- The history of reservations in the window.
