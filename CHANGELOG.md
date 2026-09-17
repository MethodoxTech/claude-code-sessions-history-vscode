# Changelog

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
