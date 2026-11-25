# Reserving the computer for a measurement

Chats run side by side on a computer, and that stays the default: builds, tests, game runs and
editors of several chats run together. A performance measurement is the exception. A benchmark,
a profiling run or a timing test is worthless when another chat starts an Unreal build or a game
in the middle of it, which used to make chats throw their results away (requested 2026-11-24).
So a chat that measures reserves the computer first, and the reservation is a real place in line.
First in line it waits a few minutes for a lull, the first moment no other chat runs heavy work,
while other chats work on; when none comes in that time, no other chat starts a command from
then on, so the wait never depends on the computer getting quiet by itself, which never happens
while several chats work (tuned 2026-11-25 from the history of every chat: holding everyone at
once would have held other chats' commands for at least 14.4 hours, and 61% of the measurement
windows ran beside another chat's build, test or game run).

The same broker hands out **build slots**, so that chats' builds take turns when memory runs short,
and **named reservations**, things one chat at a time holds across its calls, such as a
repository's landing turn (requested 2026-11-24, artifacts/time-backfill/agent-time-follow-up.md
§8).

The native broker is `src-tauri/src/reservations.rs`, with `reservations/tools.rs` (the agents'
tools and the gate), `reservations/light.rs` (light commands), `reservations/machine.rs`
(measuring the computer), `reservations/jobs.rs` (which chat a process belongs to),
`reservations/programs.rs` (programs chats left running, and stopping them, with
`wsl-programs.sh` and `wsl-stop.sh` inside WSL), `reservations/hold.rs` (processes that wait
for a window to end), `reservations/builds.rs` (build slots) and `reservations/named.rs` (named
reservations and landing turns). Every Windows chat and the WSL distributions this computer manages share
one broker, since they share the computer.

## How a measurement goes

1. **Prepare.** Reserve late: the agent builds, cooks, stages and finishes its own background
   work first, and calls
   `pc_status`, which lists what other chats run, the programs chats left running, the busiest
   and largest programs and whose they are: a chat's, Agent Studio's, the system's, or the user's
   own. Programs the user started are the only thing an agent asks the user about, with
   `studio_ask_user` (close them, or measure anyway), and it asks before reserving, so no other
   chat waits on the answer. What chats left running it handles itself (below).
2. **Reserve** once for the whole series of measured runs (five on/off pairs are one
   reservation, so the wait for other chats' work is paid once): `pc_reserve` with a purpose and,
   optionally, the minutes the measurement takes. The answer lists what still runs. A reply that
   reserves again within ten minutes of releasing hears that one reservation covers a series.
   First in line, the reservation waits for a lull (below); once its wait runs out, or its window
   opens, other chats' new commands and MCP tool calls wait, except light ones.
3. **Wait for the window.** `pc_wait` returns once no other chat runs busy work, a command, an
   MCP tool call or background work that a reply of its own still runs and waits on, unless it
   sits idle (below), nor holds what it was asked to hand over.
   Background work and programs a chat left running after its reply ended (a dev server, an
   editor) do not keep the window closed; they are listed, with the programs other chats left
   running, so that the agent can stop them first, and they show in the report.
4. **Measure** at once: warm up, run the whole series.
5. **Release early:** `pc_release` right after the last measured run, before reading logs or
   writing up. The answer is the report, whose Measurement line says whether the measurement ran
   beside other heavy work (below). A reservation also ends by itself when the reply that made it
   ends.

### Waiting for a lull

The first reservation in line does not hold anyone at first. Its window opens at the first moment
no other chat runs busy work, a command, an MCP tool call or background work a running reply of its
own waits on, other than idle work (below), and other chats work on until then: their commands go
through the gate, and a `pc_wait` of
theirs returns at once. Only when no such moment comes within the wait set in Settings →
Reservations (`Settings::lull_minutes`, three minutes unless changed, kept on this computer in app
data `reservations/settings.json`, never synced) does it hold their new work, from then on, and
the work already running is the last its window waits for. A window that opens holds their new
work from then on, a hand-over that closes it again included. Zero holds at once, as before
2026-11-25. The Reservations window and the gauge show the phase as Waiting for a lull, Holding or
Measuring, and the report says whether the window opened at a lull or how long it waited for one
before holding the others (`lullMs` in the history).

### Idle work

Work that only waits never keeps a window closed (requested 2026-11-25, after four chats waited on
a computer at 3.6% CPU behind a pull request watcher that slept between its polls and could run
for three hours, while the measurement waited for it to end). While the first reservation's window
waits, and while it is open, the broker reads the computer every two seconds, and each chat's work
is what its CLI's job ran between two readings (`machine::work`): the job's own CPU time
(`JobObjectBasicAccountingInformation`, which counts processes that already ended, so a command's
short processes count however briefly each runs), less the CLI's own process and the programs it
left running outside the CLI's tree. A chat whose CLI runs in a WSL distribution is read there too,
one reading at a time (`programs::wsl_work` with `wsl-programs.sh`), since this computer sees all
of WSL as one virtual machine: its CLI's tree there, with the time of the children each process
waited for (the `c` lines) and of processes that began between the script's two samples. Work in
progress that has kept less than a quarter of a core busy (`machine::IDLE_CORE`) by every reading
of the last ten seconds (`IDLE_FOR`) is idle, so a watcher between its polls, a server waiting for
requests or a command waiting on the network does not keep the window closed. A reading older
than fifteen seconds (`STALE`), or one that could not read the chat, tells nothing, and the window
waits for that work again. `pc_status` marks idle work, the holder's answers list it apart, and
the window that opens says it goes on beside it. Idle work that a reading then finds busy counts
as work that ran beside the measurement; work that stayed idle shows in the report on a line of its
own (`idle` in the history, Other chats' idle work in the Reservations window) and never marks the
measurement. Inside WSL only the virtual machine's load tells whether such work woke while the
window was open, since nothing reads there during a measurement.

Reservations take turns, first come first served: the first holds the computer, the others wait
in line, and their own chats' commands wait for the first like everyone else's. A chat that
reserves again only updates its purpose and estimate. Nothing is capped: a reservation, a wait
and a queue last as long as their chats need; a reservation ends only when its chat releases it
or its reply ends.

## What waits, and how

- **Claude chats.** Each chat process registers a `PreToolUse` hook callback for `Bash`,
  `PowerShell`, `Monitor` and every MCP server's tools in its `initialize` request, beside the
  compaction hooks: `tools::GATED`, `^(Bash|PowerShell|Monitor|mcp__.+)$`, anchored because
  Claude Code (2.1.332) tests a matcher that is more than names as a regular expression anywhere
  in the tool's name, where `Bash` alone would match `BashOutput`. The running reply
  answers it: with no opinion when the computer is free, the call is light, or the chat holds the
  reservation itself (its sub-agents included); otherwise with a refusal that names the chat
  measuring and its purpose and tells the agent to call `pc_wait` and run the command, or make the
  call, again. A refusal rather than a held answer, since Claude Code (2.1.332) refuses a call
  whose hook does not answer within its timeout, 30 seconds here ("PreToolUse hook did not respond
  before its timeout"). A turn a parked process starts by itself between replies, for a
  background task's report or another session's message, has no reply to answer it: the
  process's output reader answers its hook callbacks, the gate's and the others', with no opinion
  (`pool::Lent`, which lends it the CLI's input until the next reply claims the process), so its
  commands run as they would without the gate, and the hold below lets what they start run too,
  as what that chat's CLI started itself. From 1.4.0 until this was found (2026-11-25), every
  command of such a turn was refused at the timeout. What else such a turn asks is refused as a
  reply would refuse it (`providers::parked`), so the turn never waits for an answer that cannot
  come: Agent Studio's own tools answer with an error saying no reply runs, permission prompts are
  denied (a removal the safety check stopped as a reply refuses it), and an MCP server's form is
  cancelled; only the list of its tools and their start, which belong to the reply that launched
  the process, are left. Claude Code names an SDK callback
  `PreToolUse:Callback`, which Work history leaves out. It also reports a call as started before
  it asks the gate, so a call the gate refused counts for nothing: it never keeps a window closed
  nor shows in a report as work that ran.
- **Light commands** run anyway (`light.rs`): reading files, listing folders, searching text and
  asking Git about the checkout, every part of the command line. A command substitution, a script
  block, `Invoke-Expression` or any program the list does not name makes the command wait.
- **MCP tool calls** wait like commands (requested 2026-11-25, since a chat driving an open
  editor through unreal-mcp loads the computer as much as a command does). Both agents name an MCP
  tool `mcp__<server>__<tool>` to their hooks (`activity::mcp_tool`), and the broker decides by
  the server (`Broker::gate_call`): Agent Studio's own tools, `pc_wait` among them, answer for
  themselves, and servers whose tools run elsewhere, claude.ai's connectors (`claude_ai_…` in
  Claude Code) and Codex's apps (`codex_apps`), go ahead like light commands
  (`light::remote_server`); every other server may drive a program here and waits. A call
  already running keeps the window closed until it ends, as a command does: the tool decoder
  records which server and tool a call reaches (`ToolActivity::connected`, never shown), and
  `pc_status` and the report name it `<tool> of <server>`. `call_mcp_tool`, which reaches the
  servers of another place of this computer, waits in its own handler, for both agents.
- **Codex chats** on Windows get the same refusal (`reservations/codex_gate.rs`, found
  2026-11-24 on Codex 0.172). Codex runs `preToolUse` hooks before a shell command (its tool is
  `Bash` to hooks, as in Claude Code) and before an MCP tool call, and blocks either when a hook
  answers `permissionDecision: deny` with a reason; the hook's matcher is a regular expression
  on the tool's name, `^(Bash|mcp__.+)$`. Each Codex chat's app-server starts with such a hook given as a session flag,
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
  kept in memory and in app data `reservations/codex-gate.json` under the whole session flag, so
  a change of the hook's definition, its matcher included, asks Codex again: Codex skips a hook
  whose definition changed. Work history shows the gate
  only when it blocks a command. `thread/start`'s `config` does not register hooks, and the
  `untrusted` approval mode, whose requests the app could have held, is gone from Codex 0.172.
- **WSL Codex chats** run the same gate. Their hook command is this app's program at the path
  the distribution reaches it by (`'/mnt/c/…/agent-studio.exe' --pc-gate`, run by the
  distribution's shell), which WSL's interop starts on Windows, and `WSLENV` carries the pipe's
  name and the chat's id into the distribution and back out to the program. Their trust is read
  as on Windows, from an app-server started in the distribution, and kept in memory for the run.
  A distribution whose interop is turned off cannot start the program, and Codex then runs the
  command.
- **What runs** is what the replies running on this computer report: each command and monitor
  from its start until it ends (`Broker::tool`, fed by every chat run's events), and the
  background work chats' CLIs keep (`background_work`). A command is named, and judged light, as
  its agent wrote it: lines a CLI hook put before it, running a script under a `hooks` folder,
  are left out, as the window's `primaryCommand` leaves them out (a user's Codex `PreToolUse`
  hook may prepend one to every command, which made every Codex command read as that line).
- **Processes that begin while a window is open** in another chat's job wait, frozen at birth,
  until the reservation ends (`hold.rs`). A program a chat left running, such as an editor
  compiling shaders or a server rebuilding after a change, or background work its reply left,
  starts work that no gate sees. Each chat's job tells the app of every process that begins in
  it (a completion port, `JOB_OBJECT_MSG_NEW_PROCESS`), and the app suspends it at once, as
  Task Manager's Suspend does, before it can do much. It lets it go when it is plumbing
  (consoles, WSL, error reporting, this app's own gate) or light (Git, ripgrep), when its chat
  measures or was asked to hand over, and when its chat's CLI started it: anything in a replying
  chat's CLI tree, whose commands the gate looks after, and, in a chat that no longer replies,
  what its CLI started itself since the window opened, such as an MCP server it connects again.
  What a program or background work begun before then starts waits. Only processes born while
  a window is open wait, so work in progress always finishes, and they run again when the
  reservation ends, before a program of theirs is stopped, and when the app quits. Those
  waiting are kept in app data `reservations/frozen.json`, so a start after a crash resumes
  them. Windows only: WSL's processes are not Windows processes.

`pc_wait` waits as long as the computer stays reserved. Its answer, like every answer of these
tools, goes back to the CLI through the run's own channel (`Session::rx`), so a long wait never
holds up the reply's loop, and Stop ends it.

## Build slots

Several heavy builds at once compete for memory before they compete for the cores: with three or
four chats building, free commit fell to 3.5 GB on 2026-11-24 and a shell could not start a
thread. A cap inside one project's build script sees none of the others, so the broker counts every
build on the computer and holds a chat's build at its gate while another would not fit
(`reservations/builds.rs`):

- **A build** is recognized from the command a chat asks to run (`builds::is_build`): Unreal's
  `Build.bat`, `RunUAT` and UnrealBuildTool, a project's own build script (a `.ps1`, `.bat`,
  `.cmd` or `.sh` script whose name starts with "build"), `cargo build`, `test`, `check` and
  `clippy`, `dotnet build` and `test`, `cmake --build`, MSBuild, Ninja, make and Tauri's
  release build, through a shell (`pwsh -File`, `bash -lc`) too. The same gate as reservations
  asks, Claude's `PreToolUse` callback and Codex's `--pc-gate` hook.
- **What builds now** is every chat call that builds while it runs (`Call::build`) and, from the
  compilers and linkers on the computer (`cl`, `clang`, `rustc`, `link` and the like), every
  other build, one for each driver they run under (UnrealBuildTool, `dotnet`, `cargo`,
  MSBuild…): a chat's build left in the background, a Claude app or terminal session's, or one the
  user started by hand.
- **Room** is sized from bluevox's measurements that day: a compiler of its module commits 2.5 to
  3.5 GB, one build alone ran 8 compilers with 17 GB free, and two heavy builds together took free
  commit from 17 GB to 2.3. A build always starts alone. Beside others, one starts while fewer
  builds run than the cores allow (one for each eight) and at least 10 GB of commit stays free
  (`builds::BESIDE_FREE`), and only once the last build that started had 30 seconds to take its
  memory (`builds::RAMP`).
- **Waiting** is first come first served. A refused build's chat waits in `pc_wait`; when a build
  ends, or the computer's two-second look finds room, the slot is kept for the first in line for two
  minutes, and its `pc_wait` returns so that it runs the build again. While a measurement holds the
  computer, only the measuring chat gets a slot. A chat's place in line ends with its reply.

The wait shows in the reply's Time report as **Waiting for a build slot** (`slot`, On hold), apart
from the build's own time, which before counted the wait inside a build script as compiling.

## Named reservations and landing turns

A reservation can hold a thing instead of the computer: `pc_reserve` with `name` (a shared folder,
an editor that holds a project's assets) or `landing: true`, the landing turn of the repository
the chat's folder belongs to (`reservations/named.rs`). One chat at a time holds a name, first come
first served; the others wait in `pc_wait`, and their wait is **Waiting for its turn** (`turn`,
On hold) in their Time report. Names read the same however they are written (case, spaces, folder
separators). A landing turn's name is the repository's `origin` remote (`github.com/owner/repo`,
whether written as https, ssh or `git@`), else its common Git folder, read from Git's own files,
so every checkout and worktree of a repository shares one turn, a WSL folder's included through its
`\\wsl.localhost` path. Agents take it just before fetching and merging the main branch for the
final pipeline, and give it back right after the push, so another chat's landing never makes
theirs redo its pipeline (38 minutes redone one afternoon). A named reservation holds nothing else:
other chats' commands run. It ends with `pc_release` and its `name` or `landing`, or when the reply
that took it ends; `pc_release` alone releases a chat's named reservations only when it holds no
reservation of the computer. `pc_status` lists each name with its holder and those waiting, and the
history keeps each turn (`"kind": "turn"`).

## Coordinating with other chats

Agents coordinate by themselves, so the user is asked only about the user's own programs
(requested 2026-11-24).

- **Messages.** `chat_message` writes to another chat that is replying on this computer. It reads
  the message with its next tool call: in a Claude chat, a `PostToolUse` hook callback that every
  chat process registers beside the gate answers with the message as `additionalContext` (10
  seconds' timeout, answered with no opinion while the process is parked, as the gate is); in a
  Codex chat, the gate before its
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

A **program** a chat left running is a process in its job outside its CLI's own process tree, such
as an editor or a server a command started and let go, grouped with the processes it started under
the topmost of them. Inside a WSL distribution a chat's processes are those that carry its launch's
job in their environment (`AGENT_STUDIO_JOB`, which every process its CLI starts inherits):
`wsl-programs.sh` lists them, with their CPU over a second and their memory, and the CLI from its
launch's marker. They are ended with TERM, then KILL after up to ten seconds (`wsl-stop.sh`), and a
launch ends what is left of them when its CLI ends. Elsewhere a process that outlives its parent
says nothing of whose it was. A program with a window is asked to close as its close button asks
(`WM_CLOSE` to its shown top-level windows, a window another shown window owns closing with it), so
it may still ask about unsaved work, and it is waited for while it works on closing: one that sits
idle for 15 seconds may be asking something, and one still busy after two minutes is left to
finish, both reported so that the agent asks the user. What it leaves running without a window then
ends. A program without a window is ended. Every process is checked by when it began before
anything is sent to it, so a process that took another's id is never touched.

## Whose a process is

On Windows each chat CLI runs in a job object of its own (`jobs.rs`), which every process it starts
joins, an editor left open included, so a process is the chat's however it was started. Jobs limit
nothing: they let a process break away when it asks, never end their processes, and are dropped
once none of their processes runs. A process outside every job is Agent Studio's when the app
started it; a session's outside Agent Studio when it runs under Claude Code or Codex
(`machine::SESSIONS`): the Claude app's, which runs its windows and its Code sessions as processes
of one name, Claude Code's in a terminal or an editor, or Codex's; the system's when it runs
outside the signed-in session (Windows' services); and the user's otherwise. WSL's processes run inside its virtual machine, which Windows shows as one
process (`vmmemWSL`): it is WSL's, and when the chat measuring runs in WSL it counts as that
chat's own processes, since other chats' commands wait meanwhile. A WSL chat's own process on
Windows is the `wsl.exe` that runs its CLI, whose job keeps its launch followed while it runs.
Linux server hosts tell processes apart by their parent chain.

## The report

`pc_release` returns, and `reservations/history.jsonl` in app data keeps one JSON line per
reservation:

- when the window opened after the reservation, and how long it stayed open;
- what kept it closed, each chat's command with how long it ran meanwhile, and the chats asked
  to hand over, with when they read the request and how and when it ended;
- what was stopped for it, and by which chat: a chat's stops go to the reservation it holds,
  or to the one it makes next in the same reply, since a chat clears the computer before it
  reserves as often as after;
- other chats' work that ran while it was open anyway (work left running, commands of a chat
  whose gate could not run, idle work a reading then found busy), the idle work it opened beside
  that stayed idle (`idle`), and the processes that waited for it to end, by chat and program;
- the computer while it was open, read every two seconds: CPU on average and at most, the
  measuring chat's processes apart from everything else, memory in use and free, and the busiest
  and largest other programs with whose they are;
- whether the measurement ran beside other heavy work, whoever ran it (requested 2026-11-24):
  the Measurement line reads `clean`, or `ran beside other heavy work` with each thing that did:
  another chat's command or MCP tool call that ran while the window was open, unless it stayed
  idle, and every owner
  whose processes used at least a whole core and 5% of the computer in two readings or more
  (`machine::Window::beside`): a chat's programs, the Claude app, Claude Code or Codex outside
  Agent Studio, Agent Studio, the system, WSL or the user's own. The history keeps it as
  `contaminated` and `ranBeside`. A window that never opened measured nothing;
- how long other chats waited in `pc_wait` because of it, split by what kept the window closed
  at the time (time several things shared is split between them), and how many commands and MCP
  tool calls waited.

A reply waiting in `pc_wait` counts that time as **Waiting for the computer** in its time ledger
(`held`, in the On hold family of the Time report), or as **Waiting for a build slot** (`slot`) or
**Waiting for its turn** (`turn`), as the broker tells the ledger what it waits for
(`Ledger::held_for`). The release's record in Work history carries the verdict as facts
(Measurement, and Ran beside with each thing on a line), which the Time report lists below the
time on hold, response by response, with how many of them ran beside other work.

## In the window

While the computer is reserved, or chats' builds wait for a slot or chats for a turn, a gauge in
the sidebar's footer, beside Connections, names the chat and its purpose on hover with where it
stands (waiting for a lull, for commands or for chats to hand over, measuring, chats waiting,
reservations in line, builds and turns waiting). It is in the warning colour while other
chats' work finishes and in the accent while the measurement runs. The window follows
reservations through `studio-pc` events and `pc_state`; nothing about them is saved or synced.

The gauge opens the Reservations window (`ReservationsDialog.svelte`), which `/reservations` also
opens at any time. It shows what waits In line (each name with its holder and the chats waiting
for it, and the builds waiting for a slot), the reservations now, each with what its window waits
for and the chats waiting, then every reservation this computer's history kept (`pc_history`,
read whole, newest first): together, how many measurements, how many ran beside other work, how
long they waited to start and how long other chats waited; and each one with how long it waited
and measured, whether it ran beside other work and what that was, what kept its window closed,
the chats it asked to hand over, what was stopped for it, the processes held until it ended, the
computer while it was open (CPU, this chat apart, with WSL when it measured there, memory and the
busiest other programs with whose they were) and why other chats waited; then the turns the
history kept. A reservation that ends joins it
while the window is open. Its chat opens from it. Each computer's desktop app keeps its own
history, so the Viewer shows none.

## Chats begun before reservations

A chat agent learns of reservations from its first message (`tools::GUIDANCE`), and after a
compaction. A Claude session begun before Agent Studio 1.4.0 never read it, though each process
of its chat has the tools, and a system prompt cannot reach it, since Claude Code keeps the one a
session started with. Its next reply's context carries the guidance once (`guidance_added`,
requested 2026-11-25), as a session begun under an earlier rule for pages hears the current one:
the binding records `reservations_rule` once a session has it, and one written before
2026-11-25 has not, so a session begun on 1.4.0 hears it a second time.

## Not yet

- Holding processes that begin inside a WSL distribution while a window is open: a WSL chat's
  program that starts work then is in the report, under WSL's virtual machine.
- A Codex thread begun before Agent Studio 1.4.0 keeps the tools it started with: its commands
  and MCP calls wait like any other chat's, but it has no `pc_wait` to wait with, nor
  `pc_reserve` to measure with.
