# Changelog

Notable changes in each Agent Studio release, newest first. Settings → About shows this list, and
each GitHub release uses its section as release notes. `npm run release:version` adds the new
version's section from the commit subjects since the previous release; edit it before committing.
See [automatic updates](docs/UPDATES.md#publishing-a-release).

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
