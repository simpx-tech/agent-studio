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
§8). It runs **merge trains**, which land the branches several chats queued together, with one
merge, one pipeline and one push (requested 2026-11-27, below). A measurement of GPU work alone
reserves only that (`scope: "gpu"`), and other chats' builds and headless tests run on beside it.

The native broker is `src-tauri/src/reservations.rs`, with `reservations/tools.rs` (the agents'
tools and the gate), `reservations/light.rs` (light commands), `reservations/machine.rs`
(measuring the computer), `reservations/jobs.rs` (which chat a process belongs to),
`reservations/programs.rs` (programs chats left running, and stopping them, with
`wsl-programs.sh` and `wsl-stop.sh` inside WSL), `reservations/hold.rs` (processes that wait
for a window to end), `reservations/builds.rs` (build slots), `reservations/named.rs` (named
reservations and landing turns) and `reservations/train.rs` (merge trains). Every Windows chat and the WSL distributions this computer manages share
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
   opens, other chats' new commands and MCP tool calls wait, except light ones. With
   `scope: "gpu"`, for a measurement that reads only the GPU (frame times, a GPU capture), only
   what renders waits or keeps the window closed (`builds::renders`, requested 2026-11-27, after a
   measurement of frame times held every other chat's builds and test runs): a game, an editor or
   an engine's run not given `-NullRHI` (bluevox's `Run-Tests` runs its editor under it), browser
   tests (Playwright, `npm run verify`), and MCP tool calls of servers here, which may drive an
   editor. Other chats' builds take their slots as usual, processes their programs start are not
   held, and the report records the scope.
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
measurement. While the window is open, a WSL chat whose idle work it opened beside is read inside
WSL every ten seconds (`WSL_DURING`, `wanted_inside`), so that such work is named when it wakes,
as a chat's on this computer is; a reading costs a launch of the script and a second of sampling
there, so an open window reads only those chats, and one that opened beside no idle WSL work
reads nothing inside WSL.

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
  asking Git about the checkout, every part of the command line. A command substitution,
  `Invoke-Expression`, `& $variable` or any program the list does not name makes the command wait.
  So does a script block, unless it is the block a `ForEach-Object`, `Where-Object` or
  `Sort-Object` runs for each item (`%`, `?`, `foreach`, `where`), or a `foreach (...)` loop's over a
  variable, quoted names or a light command, and every statement in it is light (requested
  2026-11-27, after a loop that only read files waited out a measurement); a statement reading a
  variable's property (`$_.FullName`, `$_.Length -gt 100`), a PowerShell variable set to a light
  command (`$text = Get-Content log.txt -Raw`) and read-only .NET calls (`[IO.File]::ReadAllText`,
  `[IO.Path]::`, `[regex]::`) are light too.
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

## Build slots and memory grants

Several heavy builds at once compete for memory before they compete for the cores: with three or
four chats building, free commit fell to 3.5 GB on 2026-11-24 and a shell could not start a
thread. A cap inside one project's build script sees none of the others, so the broker counts every
build on the computer and holds a chat's build at its gate while another would not fit
(`reservations/builds.rs`). Reading the free memory once, as a build asked to start, was not enough
(2026-11-26): a build that started with 6.1 GB of commit free lost a compiler to an internal error
when other chats' builds and games, started after it, took the rest, and one build hung for 94
minutes on a full page file while its chat held a landing turn. So what starts is **granted** its
memory, which the broker holds for it until it ends.

- **What a command asks** is read from it (`builds::weight`): a **build** (Unreal's `Build.bat`,
  `RunUAT` and UnrealBuildTool, a project's own build script, a `.ps1`, `.bat`, `.cmd` or `.sh`
  script whose name starts with "build", `cargo build`, `test`, `check` and `clippy`, `dotnet build`
  and `test`, `cmake --build`, MSBuild, Ninja, make and Tauri's release build, through a shell such
  as `pwsh -File` or `bash -lc` too); a **build of a few files** (a build script run with `-Check` or
  `-SingleFile`, which compiles the files a change touched and links nothing); or a **run**, a game,
  an editor or a test run of an engine (`UnrealEditor` itself, or a project's `Run-Game`, `Run-Net`,
  `Run-Tests` or `Run-Editor` script). A build script's dry run (`-WhatIf`) asks nothing, and of
  several commands on one line the heaviest counts. The same gate as reservations asks, Claude's
  `PreToolUse` callback and Codex's `--pc-gate` hook.
- **What builds now** is every chat call that builds while it runs (`Call::weight`, a build of a
  few files apart, which takes no slot) and, from the compilers and linkers on the computer (`cl`,
  `clang`, `rustc`, `link` and the like), every other build, one for each driver they run under
  (UnrealBuildTool, `dotnet`, `cargo`, MSBuild…): a chat's build left in the background, a Claude app
  or terminal session's, or one the user started by hand.
- **Available memory** is the free commit less what the grants of the work started before have not
  taken yet: each grant less what its chat's processes use now (`available`), so a build that has
  not grown yet, or a game run between its loads, still keeps its room.
- **Room** is sized from bluevox's measurements: a compiler of its module commits 2.5 to 3.5 GB
  (`builds::COMPILER`), one build alone ran 8 compilers with 17 GB free, and two heavy builds
  together took free commit from 17 GB to 2.3. A build always starts alone. Beside others, one
  starts while fewer builds run than the cores allow (one for each eight), at least 10 GB stays
  available (`builds::BESIDE_FREE`), and the last build that started had 30 seconds to take its
  memory (`builds::RAMP`). A build of a few files needs 4 GB available (`LIGHT_FREE`), unless no
  grant holds memory; it takes no slot, nor waits for the last build to grow, nor behind the builds
  in line, and neither does a run.
- **A run needs what runs of its kind took** (requested 2026-11-27, after a 30-second filtered
  test run waited 4 and 16 minutes for the 8 GB every run asked): its kind is its program or script
  and the flags that change what it takes (`builds::signature`: `run-tests -filter`,
  `run-game -mode net`, `unrealeditor-cmd -nullrhi`), and it needs the most the last ten runs of
  that kind took, a quarter more and half a gigabyte, between 2 and 16 GB (`builds::run_need`), or
  8 GB (`RUN_FREE`) before one was measured. A run's peak is the most its chat's processes used
  beyond what they used as it began, read with every look at the computer while its grant holds,
  and kept with its kind when the grant ends, once it held ten seconds (`keep_peak`), in
  `reservations/peaks.json` beside the history.
- **A build waits a while for two compilers** (requested 2026-11-27, after two bluevox builds ran 12
  and 15 minutes on one compiler, granted 3.5 GB while 15.7 GB of commit was free and held for other
  chats' runs, where the same builds took about four minutes on six to eight): one that would be
  granted less than two compilers (`builds::FEW`) while other chats' work holds memory that may
  free waits up to three minutes since it first asked (`FEW_WAIT`), then starts with what there is;
  alone, it starts at once.
- **A grant** (`builds::grant`): a build gets what is available less 3 GB left to the rest of the
  computer (`GRANT_KEEP`), between one compiler and eight (`GRANT_MOST`); a build of a few files up to
  two compilers; a run what it needs. The broker writes it to the chat's file in app data,
  `reservations/grants/<chat>.json` (`{"bytes": …, "weight": "build" | "light" | "run",
  "grantedAt": …}`), which every Windows chat CLI's commands find by the `AGENT_STUDIO_PC_GRANT`
  variable (`chat_env`, beside `AGENT_STUDIO_PC_CHAT`, the chat's id), so that a build script runs as
  many compilers as its grant holds: bluevox's `Tools/Build.ps1` runs one for each 3.5 GB of it.
  A grant ends once its call ended (or never started within two minutes), the chat's compilers
  stopped, since a build left in the background goes on after its call, and 30 seconds passed since
  it was granted (`settle_grants`); its file goes with it, and the app's start clears them all. The
  window shows the grants held (`grants` in `pc_state`).
- **Waiting** is first come first served among builds; a run or a build of a few files behind a
  build that waits starts when there is room for it. A refused chat waits in `pc_wait`; when work
  ends, or the computer's two-second look finds room, a slot, or room for a run, is kept for the
  first that fits for two minutes, with the memory it will be granted set aside, and its `pc_wait`
  returns so that it runs its command again. While a measurement holds the computer, only the
  measuring chat gets a slot (any chat, beside one of GPU work alone). A chat's place in line ends
  with its reply.

The wait shows in the reply's Time report as **Waiting for a build slot** (`slot`, On hold), apart
from the build's own time, which before counted the wait inside a build script as compiling. The
history keeps every wait for a slot or for room as it ends (requested 2026-11-27, since a chat's
waits for room left no trace once its reply ended): `"kind": "wait"`, with the chat, what it asked
(`weight`, its `label` and a run's `signature` and `needBytes`), why it waited when it was last
refused (`why`: `line`, `slots`, `memory`, `ramp`, `compilers` or `room`), when it asked, when a
slot was kept for it and when it ended, how long it waited (`waitedMs`), and how (`endedBy`:
`started`, `unused` when the slot kept for it went to the next, `reply` or `closed`).

## Named reservations and landing turns

A reservation can hold a thing instead of the computer: `pc_reserve` with `name` (a shared folder,
an editor that holds a project's assets) or `landing: true`, the landing turn of the repository
the chat's folder belongs to (`reservations/named.rs`). One chat at a time holds a name, first come
first served; the others wait in `pc_wait`, and their wait is **Waiting for its turn** (`turn`,
On hold) in their Time report. Names read the same however they are written (case, spaces, folder
separators). A landing turn's name is the repository's `origin` remote (`github.com/owner/repo`,
whether written as https, ssh or `git@`), else its common Git folder, read from Git's own files,
so every checkout and worktree of a repository shares one turn, a WSL folder's included through its
`\\wsl.localhost` path. Agents run the full pipeline first, on their branch merged with a freshly
fetched main branch, and take the turn only then: under it they fetch again and push at once when
the main branch has not moved, or merge what came and run again the checks it could affect, then
push, and give the turn back right after the push (requested 2026-11-26, after five chats waited 77
to 172 minutes in line while each holder ran its whole pipeline under the turn). So another chat's
landing never makes theirs redo its whole pipeline (38 minutes redone one afternoon), and none
waits through another's. A named reservation holds nothing else: other chats' commands run. It
ends with `pc_release` and its `name` or `landing`; `pc_release` alone releases a chat's named
reservations only when it holds no reservation of the computer. `pc_status` lists each name with
its holder and those waiting, and the history keeps each turn (`"kind": "turn"`, its `endedBy`
`release`, `reply`, `stalled` or `closed`).

A turn **outlives the reply that took it** by five minutes (`TURN_KEEP`, requested 2026-11-26: a
message the user sent ended a reply waiting on its build, and its chat lost the landing turn and its
place, going back to the end of the line): the chat's next reply takes it on as it starts
(`run_started`), held or still in line, and it ends only once that time passed with no reply of its
chat (`watch_turns`, `endedBy: "reply"`). Closing the chat (Move to History, deleting it) ends it at
once (`chat_closed`, from `release_conversation` with `closed`).

A turn whose holder's work **stalls** goes to the next in line (requested 2026-11-26, after a build
hung 94 minutes on a full page file while its chat held the landing turn and four chats waited).
While a chat holds a turn, the computer is read every ten seconds (`STALL_READ`), and its work is
the chat job's CPU since the last reading (`machine::work`, as for idle work above). When the chat
runs a build or a run (`builds::weight`) or background work, is not waiting in `pc_wait`, and that
work keeps under a quarter of a core (`machine::IDLE_CORE`) for ten minutes (`STALL_WARN`), the
holder hears it may have stalled, once, with its next tool call; after twenty (`STALL_RELEASE`) the
turn goes to the next chat in line, when one waits, and the holder hears why (`endedBy:
"stalled"`). Work that uses the CPU again starts the count afresh, a chat thinking between calls
runs nothing to watch, and a chat inside WSL, whose work this computer's readings do not see, is
not watched. The Reservations window marks a held turn kept for its chat's next reply, or whose
work has used no CPU, and the chat's row in the sidebar says so on hover.

## Merge trains

Landing one chat at a time still redid work when several chats were ready together: every push
moved the main branch under the next chat in line, which merged it and ran its pipeline again under
the turn (2026-11-26: turns held 31, 26 and 11 minutes in a row). A repository with a **merge
train** lands the branches queued together instead (requested 2026-11-27, `reservations/train.rs`):

- **The repository says how**, in `.agent-studio/train.json` in its main checkout (the folder whose
  `.git` every worktree shares, `named::main_checkout`): `{"branch": "main", "command":
  ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "Tools/Land-Train.ps1"],
  "maxCars": 4}`. Without it `pc_land` says so, and the chat lands with its landing turn.
- **A chat queues its branch** with `pc_land` and a purpose, once the branch, merged with a freshly
  fetched main branch, passed its own pipeline and is committed. The car carries the commit its
  checkout's branch is on, read from Git's own files (`named::head`); a checkout on the main branch
  itself or with a detached head is refused. Calling it again brings a waiting car up to date in its
  place, a landing turn the chat held or waited for at that repository goes, and `pc_release` with
  `landing: true` takes a car that has not left off the train (`Broker::withdraw`). A car needs no
  running reply; closing its chat takes it off.
- **A train leaves** once cars wait (`board`): it asks the repository's landing turn in line with
  the chats landing by hand (its id, `train:<repository>`, stands in for a chat's in turns, slots and
  grants), then, once the turn came and no measurement holds the whole computer, a build slot, and
  takes up to `maxCars` cars, earliest first (`depart`). Its memory grant is held until its build has
  compiled, however long it takes to start.
- **It runs the repository's command** in the main checkout, in a job of its own, so its builds count
  as a chat's and a measurement waits for it (`train::run`): `AGENT_STUDIO_TRAIN_CARS` names a JSON
  file of the cars (`{"train", "repository", "branch", "cars": [{"id", "chat", "title", "purpose",
  "worktree", "branch", "sha"}]}`), `AGENT_STUDIO_TRAIN_RESULT` the file it writes what became of
  each car to (`{"landed": [ids], "sha", "ejected": [{"id", "reason", "log"}], "requeue": [ids],
  "note"}`), `AGENT_STUDIO_TRAIN_DIR` a folder for its logs (app data `reservations/trains/…`, with
  `train.log`, what it printed), and `AGENT_STUDIO_PC_GRANT` its grant. It exits 0 once it wrote its
  result; it is stopped after three hours (`train::LONGEST`). bluevox's `Tools/Land-Train.ps1` merges
  the cars onto a fresh main branch in a pooled worktree, resolves the conflicts of its changelog's
  top entries, runs one build and the whole suite, finds the car that broke it by prefixes, pushes
  once and pulls the main checkout.
- **Each car's chat hears** what became of it with its next tool call, and its `pc_wait` returns
  then (`Waiting for its turn` in its Time report): landed (at which commit, on a train of how many,
  in how long), ejected with the reason and the log, or waiting for the next train, which it boards
  first. A train whose command failed gives its cars back to wait for the next; two failing in a row
  give them back to their chats to land by hand (`train::FAILURES`). The chats waiting for the
  landing turn by hand hear that the main branch moved, and `pc_status` lists the trains, their
  cars and what the last trains landed.
- **The history keeps each train** (`"kind": "train"`: its cars with their outcome and reason, the
  commit it pushed, its note, the error that stopped it), its turn (`endedBy: "train"`) and its wait
  for a slot.

## Leases: what a chat holds while it stays open

A chat's work may hold something of a project's for longer than a reply, such as bluevox's claim on
a built worktree of its pool, which its next tasks build in (requested 2026-11-26: "Agent Studio
knows when a chat is closed"). Every Windows chat CLI starts with a folder of its own in its
environment, `AGENT_STUDIO_LEASE` (app data `leases/<chat>`, `src-tauri/src/leases.rs`), where a
project's scripts write what the chat holds: bluevox's `Tools/Claim-Worktree.ps1` leaves a lease file
there beside its claim, and treats a claim whose lease file is gone as no claim. Agent Studio
removes the folder when the chat is closed, moved to History or deleted (`release_conversation` with
`closed`, which a Viewer sends through the relay as its `release` job's `closed`), and as the window
starts for every chat the workspace no longer holds (`prune_leases`), a chat deleted while the
computer was away. The app's start, which moves saved chats to History, closes none, and neither
does a History move that arrives by sync. Nothing else in Agent Studio reads a lease: what it means
is the project's.

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
(`Ledger::held_for`). A chat in line for a turn waits for its turn even while a measurement holds
the computer, and the measurement's report leaves its wait out; once its turn comes, it waits for
the computer (until 2026-11-26 the hold came first, and 43 of one chat's 172 minutes in line for a
landing turn read as held). The release's record in Work history carries the verdict as facts
(Measurement, and Ran beside with each thing on a line), which the Time report lists below the
time on hold, response by response, with how many of them ran beside other work.

## In the window

A gauge in the sidebar's footer, beside Connections, is always there on the desktop (requested
2026-11-26; until then it showed only while something waited) and opens the Reservations window. While
the computer is reserved, or chats' builds wait for a slot or chats for a turn, it names the chat and
its purpose on hover with where it stands (waiting for a lull, for commands or for chats to hand
over, measuring, chats waiting, reservations in line, builds and turns waiting), in the warning
colour while other chats' work finishes and in the accent while the measurement runs; otherwise it
is quiet and says Reservations. The window follows reservations through `studio-pc` events and
`pc_state`; nothing about them is saved or synced.

Each chat's row in the sidebar marks where it stands with this computer, beside its running time as
the monitoring pulse marks a monitor (`pcChatState`, requested 2026-11-26): the gauge while it
reserves the computer, in the accent once it measures; an hourglass in the warning colour while it
waits for the computer another chat reserved, a place in line to reserve it, a build slot, room for
a game or test run, its turn, or its branch's merge train, waiting or on its way (`waiting` in
`pc_state` names the chats waiting in `pc_wait` for the computer, `trains` the trains and their
cars); a quiet flag while it holds a landing turn. Its hover and accessible name say which. And
the running reply of a chat that waits shows a card of its own under its heading, in the warning
colour, with what it waits for, behind whom, and how long it has waited where that is known
(`pcWaitCard`, `MessageView`'s `onHold`); its heading's live label says the same in place of
Responding.

The Reservations window and the Time report close on a click on their backdrop as they do on Escape
and their close button, through the page's own close: until 2026-11-26 the backdrop closed the
`<dialog>` alone, the page went on holding it open, and the next click opened nothing.

The gauge opens the Reservations window (`ReservationsDialog.svelte`), which `/reservations` also
opens at any time. It shows what waits In line (each merge train with its cars, each name with its
holder and the chats waiting for it, and the builds waiting for a slot), the reservations now, each
with its scope when it is of GPU work alone and what its window waits
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
- Watching a WSL chat's work under a turn: its work runs where this computer's readings do not see,
  so a stalled build of a WSL chat holding a turn keeps it until it is released, its chat is closed
  or five minutes after its reply ends.
- A message reaches a chat with its next tool call, so a chat whose call hung hears that its work
  may have stalled, or that its turn went on, only once that call ends; the Reservations window and
  the sidebar show it at once.
