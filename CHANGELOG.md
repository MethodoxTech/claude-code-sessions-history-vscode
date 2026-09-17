# Changelog

## 0.1.1

- Fix the welcome panel staying on screen behind an opened session, which left a
  full viewport of placeholder text above the conversation and the statistics.
  A user-agent `[hidden]` rule loses to any author `display`, and both the
  welcome panel and the sidebar set one
- Show each pull request once in a session header. Claude Code re-writes its
  `pr-link` record on every turn, so a long session repeated the same few links
  dozens of times. Headers with more than four now collapse the rest behind a
  disclosure
- Add `claudeSessions.showInActivityBar` to hide the activity bar icon while
  keeping the extension installed
- Right-click a session in the browser panel's list to copy its title, session
  id or project path, toggle its bookmark, or open its transcript. **Copy
  Session Title** is also on the tree view's context menu

## 0.1.0

First release.

- Sessions tree in the activity bar, grouped by date or by project, with bookmarks and a filter
- Session browser panel (`Ctrl+Shift+H` / `Cmd+Shift+H`) with the full conversation
- Model-generated session titles, with a fallback to your first message
- Thinking blocks, tool calls, and inline diffs for file edits from the recorded structured patch
- Cards for artifacts and Markdown files a session produced, with preview and open actions
- Deep search across the text of every message, streaming results as they are found
- Statistics: sessions per day, models, branches, busiest projects, tokens and transcript size
- Markdown export for one session or a date range
- Resume a session in a terminal, started in that session's project directory
- Metadata cache keyed on transcript size and modification time, and an optional file watcher
