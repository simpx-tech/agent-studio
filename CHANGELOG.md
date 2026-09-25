# Changelog

Notable changes in each Agent Studio release, newest first. Settings → About shows this list, and
each GitHub release uses its section as release notes. `npm run release:version` adds the new
version's section from the commit subjects since the previous release; edit it before committing.
See [automatic updates](docs/UPDATES.md#publishing-a-release).

## 0.4.0 - 2026-09-25

Chats no longer wait for each other, and notifications now say which chat finished and what it said.

### Added

- Run replies in several conversations at once, including chats with the same account, and stop each one on its own
- Send a chat's queued messages as soon as its reply finishes, even while another chat is open
- Title notifications with their chat and show the start of the reply, the text a stopped reply had reached, the error, or the question waiting for you
- Group History by app session, titled with the day and time Agent Studio started
- See what each running tool call is doing, such as Running `npm test`, before it folds into its group's count
- Move a chat to History from its sidebar row; moving the open chat opens the next Active one
- Keep every unsent new chat as its own draft in its folder, marked with a pen until you send or discard it

### Changed

- Remove the "An agent is responding in another conversation" notice; the sidebar shows which chats are replying
- Make Move to history the first action in the chat toolbar
- Mark chats with a running reply with a spinner and the open chat with a bar
- Show a spinner beside Responding, and a question icon and orange highlight while a reply waits for your answer
- Show sent images above the message bubble, with thumbnails that leave out file names
- Draw the Stop response icon as an outline like the other icons

### Fixed

- Show desktop notifications for a later question in a reply and for MCP input requests
- Start new chats with the agent and account you last chose, not the account of the reply that started last
- Stop "Cannot finish workspace save" errors when Agent Studio starts
- Give every chat started at the same time a generated title, not only the first two
- Return a queued message to the composer when it no longer fits the workspace, instead of dropping it
- Keep the open chat in place when a reply finishes in another chat

## 0.3.0 - 2026-09-25

Tool calls now show what ran and what came back, and each reply keeps its plan and background work in its footer row.

### Added

- See the command each tool call ran and what it returned: output with its exit code, standard error, numbered file contents, search matches, web page text and connected tool results
- See the images an agent viewed or a tool returned, and open them full size
- Give tool calls and groups icons for what they do, such as the Git logo for git commands and a flask for test runs
- Show an edit's own diff inside its tool call
- Keep complete tool outputs on the computer that ran the reply until their chat is deleted, without adding them to synced history
- Show a reply's plan, workflow runs and background work as toggles beside its elapsed time
- Count every kind of action in Work history groups, such as Read 3 files and ran 2 commands
- Show the app version and this changelog in Settings → About

### Changed

- Save and load large workspaces without blocking the window
- Look up accounts and chats faster in large workspaces

### Fixed

- Name new conversations with generated titles again
- Open Connections without freezing in large workspaces
- Keep chats responsive while the relay has nothing new
- Keep long chats responsive while selecting text
- Keep following background work after its reply ends
- Mark native workflow runs with a workflow icon in the reply row

## 0.2.1 - 2026-09-24

### Fixed

- Keep the Viewer's workspace copy in IndexedDB, so signing in works after a workspace outgrows browser local storage

## 0.2.0 - 2026-09-23

The first published release. Installed desktop apps update themselves from this version on.

### Added

- Chat with Claude, Codex and Gemini through the CLIs and subscriptions already on your computers
- Connect several accounts per agent with separate profiles, and switch accounts between replies
- Run chats on other computers and managed WSL distributions through a private relay workspace
- Follow and answer chats from the installable Viewer app on phones and in browsers
- Get desktop notifications with the Agent Studio chime, mobile push alerts, and pending chat badges
- Review each reply's reasoning, tool calls, sub-agents, hooks, and plans in Work history
- See the files each reply edited, rewind conversations, and undo recorded file edits
- Queue, steer, and stop running replies, fork conversations, and compact their context
- Answer agent questions, approve plans in Plan mode, and fill in MCP forms inside the chat
- Track 5-hour, weekly, and context usage with pace guides, credits, and estimated spend
- Manage MCP servers, plugins, skills, and hooks from Model context
- Use slash commands, skills, file and app mentions, templates, and images in the composer
- Preview HTML and SVG artifacts and interactive visualizations beside the chat
- Keep unsent drafts per chat and folder across restarts
- Choose a Dark, Light, or System appearance
- Install signed desktop updates from GitHub Releases in the background
