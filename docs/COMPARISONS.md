# Comparisons

A comparison sends one task as several runs and shows them side by side, to see how models and
reasoning levels behave and perform on the same work: fixing an issue, making a 3D model, anything
a chat does (requested 2026-11-24). A run is an agent, account, model and reasoning level, with
Fast when its model offers it, and the same run can go several times, to see how much one model
varies under exactly the same conditions. There is no judge: the user reads the runs and picks one,
at most.

The model is `src/lib/comparisons.ts`, the view `src/lib/components/ComparisonView.svelte`, the
composer's run picker `CompareRuns.svelte`, the confirmation of Apply and Remove
`ComparisonDialog.svelte`, and the worktrees `src-tauri/src/worktrees.rs`.

## Starting one

Compare, beside Build/Plan and Fast under a new chat's composer, turns the chat into a comparison.
The runs picker above the message starts with the toolbar's Agent, Model and Reasoning once. Its
last entry adds the toolbar's choice now, or runs it once more when it is there already, and each
run has its count (− and +, ×N; at 0 it goes), so a comparison of three models, of one model at
three reasoning levels, or of one model five times, takes a few clicks. One at a time starts each
run once the one before it ended, for comparisons of time where runs side by side would slow each
other's builds and tests; by default they all start at once. Send needs two runs or more.

Each run is a chat of its own, made with the comparison: the same message (text and images), its
own settings and account, and the computer and folder the new chat chose. Nothing else differs:
no run reads another's context, and runs of one comparison never fork from an earlier chat.

## Where runs work

- **A project folder** must be in a git repository on this desktop's own computer, Windows or a WSL
  distribution it manages. Before any run starts, the computer makes one snapshot of the folder as
  a commit through an index of its own (`git add --all` with `GIT_INDEX_FILE`, `write-tree`,
  `commit-tree`), so it holds uncommitted and untracked files and leaves out ignored ones, without
  touching the user's index, stash, branches or files. Each run then gets a `git worktree` of that
  commit on a branch of its own, `agent-studio/compare-<id>-<n>`, in app data (`worktrees/` here,
  `~/.local/share/<identifier>/worktrees/` inside a distribution), never inside the repository,
  where watchers such as a dev server would react to it. Files the repository's
  `.worktreeinclude` names (Claude Code's convention, gitignore patterns), such as `.env`, are
  copied into each worktree, regular files only, as Claude Code copies them into its own. The run's
  chat names the worktree's copy of the chosen folder as its folder, so its CLI, console Run,
  Model context, mentions and Files edited all work there without knowing about comparisons. A
  folder outside git, on another computer or in the Viewer refuses Compare with the reason and
  keeps the draft.
- **Standalone** runs need nothing more: each chat gets a Standalone folder of its own.

A run's reply reads one line about it in its guidance, from the computer's own record of the
worktrees, never from the window (`worktrees::note`): the branch, the folder it was made from, and
to keep its work in its worktree without pushing, merging, rebasing or switching branches.

## The comparison

The workspace keeps one record per comparison in the optional synced field `comparisons`
(`{id, createdAt, location, isolation, runs: [{conversationId, worktree?, branch?}], oneAtATime?,
picked?, applied?, removed?, at}`), merged per comparison like pins: each side's changes since the
base, the later change of one comparison, and a side without the list (an older relay or app)
removes nothing. The runs' chats are ordinary conversations.

The sidebar lists a comparison once, as its first run's chat in the comparison's own folder, with a
columns mark, `N runs` on hover and its name for assistive technology. That row reads the whole
comparison (`comparisonFace`): it runs while any run runs and waits for an answer when one asks.
The other runs stay out of Active, History, search and the pending count. Move to history,
Snooze, Pin and the sidebar's order act on the row; Move to history and deleting it take every
run, and deleting removes the worktrees too, once the runs' CLIs are released.

Opening the row shows the comparison in the chat's place: the task once at the top, then a column
per run, its model mark, model, reasoning and account, numbered when the same run repeats, its
state (Waiting, Running, Done, Failed, Stopped), its time, tokens, cost and changed files, its
branch, Pick and Open chat, and below them the run's own messages as its chat shows them, live
while it runs, with their questions answerable in place. Columns are at least 360px wide and
scroll sideways, their headings stay in view, and a waiting run has Start now.

Pick marks one run, and picking it again unmarks it. For a worktree comparison on the computer
that made it, Apply to folder lists the files the picked run changed since the snapshot (its
worktree as it is now: commits, uncommitted and untracked files), then puts them into the folder
as uncommitted changes with `git apply`, all or nothing: a folder that changed since in the same
places refuses with git's reasons, and the run's branch is still there to merge by hand. Remove
worktrees, confirmed, releases the runs' parked CLIs and removes every worktree and branch with
the changes in them; the chats stay, without their folders.

Open chat shows a run's own chat, which can go on like any chat, with a note naming the run
("Run 2 of 4") and Back to comparison.

## Alerts

A run's end is quiet while another run of its comparison runs or has not started: the last one to
end announces the comparison, on the desktop and through the relay (`quietRun`). Questions and forms
alert as they come. A comparison on screen in a focused window raises no alert for any of its runs,
and an alert about a run opens the comparison.

## Not yet

- Comparisons in project folders of other computers, through the relay; Standalone ones run
  wherever the new chat runs.
- Follow up to all: the same next message to every run.
- A setup command per folder, such as `npm ci`, before the runs start.
- Showing the runs' files side by side in one synced viewer, as `compare_files` does for one reply.
- A leaderboard across comparisons, and saved tasks to run again when a model comes out.
- In the Viewer, which reads only the open chat whole, every column but the first shows its run without the work its replies recorded; the run's own chat shows it.
