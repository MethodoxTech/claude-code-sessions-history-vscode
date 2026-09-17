# Claude Code Sessions History

Browse, search and export every [Claude Code](https://claude.com/claude-code) session on your
machine, from inside VS Code.

Claude Code writes each session to a JSON Lines transcript under `~/.claude/projects` and gives you
no way to read it back. This extension does: a docked tree of your sessions, a full browser panel
with the conversation, deep search across every message, statistics, Markdown export, and one click
to resume a session in a terminal.

Everything runs locally. Nothing is uploaded, there is no telemetry, no account, and no paid tier —
every feature listed here is in the extension you install.

## Features

**Two ways in.** A Sessions tree in the activity bar for navigation while you work, and a full
browser panel (`Ctrl+Shift+H` / `Cmd+Shift+H`) for reading, searching and statistics.

**Real session titles.** Claude Code generates a title for each session; sessions that never got one
fall back to your first message. Sessions group by date or by project, whichever you prefer.

**The whole conversation.** Your messages and Claude's, collapsible thinking blocks, every tool call
with its input and output, and inline diffs for every file Edit and Write — read from the structured
patch Claude Code records, not reconstructed from text.

**Files a session produced.** Artifacts and Markdown documents appear as cards: open the published
artifact in your browser, preview the file, or open it in the editor.

**Search that reaches the message bodies.** Filter by title, project or branch instantly, or turn on
deep search to scan the text of every message in every transcript. Results stream in as they are
found and clicking one jumps to that message.

**Statistics.** Sessions per day, model and branch distribution, busiest projects, tokens processed,
and total transcript size.

**Export to Markdown.** One session or a date range, with thinking and tool calls folded into
`<details>` blocks and file edits kept as diffs.

**Resume.** Reopen any session in a terminal with `claude --resume`, started in that session's own
project directory so Claude Code can actually find it. The command is configurable.

**Fast on real histories.** Session metadata is cached against each transcript's size and
modification time, so only changed transcripts are re-read. Conversations are paged into the view
rather than rendered whole — a 60 MB transcript opens without freezing the panel.

## Usage

1. Install the extension.
2. Press `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS), or open the Sessions view from the activity bar.
3. Pick a session to read it.

Everything is also available from the command palette under **Claude Sessions**.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and run at least once
- VS Code 1.85.0 or later

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeSessions.showInActivityBar` | `true` | Show the icon in the activity bar. Off keeps the extension without the icon. |
| `claudeSessions.claudeHome` | *(empty)* | Where to read transcripts from. Empty uses `$CLAUDE_CONFIG_DIR`, then `~/.claude`. |
| `claudeSessions.groupBy` | `date` | Group the tree by `date` or by `project`. |
| `claudeSessions.showThinking` | `true` | Show thinking blocks. |
| `claudeSessions.showToolCalls` | `true` | Show tool calls. |
| `claudeSessions.showSidechains` | `true` | Show subagent threads. |
| `claudeSessions.toolOutputLimit` | `4000` | Characters of tool output kept per call. |
| `claudeSessions.pageSize` | `60` | Messages rendered per batch. Lower it for very long sessions. |
| `claudeSessions.deepSearchIncludesToolCalls` | `false` | Also search tool inputs during a deep search. |
| `claudeSessions.autoRefresh` | `true` | Refresh when transcripts change on disk. |
| `claudeSessions.resumeCommand` | `claude --resume {sessionId}` | The command Resume runs. `{sessionId}` and `{projectPath}` are substituted. |

## Privacy

The extension reads files under your Claude Code home directory and writes nothing back to it. It
makes no network requests of any kind, collects no telemetry, and needs no sign-in. The only data
it stores is a metadata cache and your bookmarks, both in VS Code's own extension storage.

Two actions reach outside VS Code, and only when you ask for them: **Open in browser** on an
artifact card opens a `claude.ai` link, and **Resume** starts a terminal running Claude Code.

## How it works

Claude Code appends one JSON object per line to
`<claude home>/projects/<encoded project path>/<session id>.jsonl`. Reading those back has two
wrinkles worth knowing about, because they are where naive transcript readers go wrong:

**The encoded folder name is not a path.** Claude Code replaces every path separator with `-`, but
it replaces `_` and `.` the same way, so `C:\Projects\App_2025` and `C:\Projects\App\2025` both
encode to `C--Projects-App-2025`. Decoding is therefore guesswork. This extension reads the `cwd`
field recorded inside the transcript instead, which is exact, and only falls back to decoding the
folder name — verified against the filesystem — when no record carries one.

**Not every `user` record is from you.** Claude Code stores tool results, slash-command plumbing,
IDE state and injected reminders as user-role messages. Showing those as things you said makes a
transcript unreadable, so they are filtered out. A prompt you typed while Claude was still working
is stored differently again, as a queued attachment; those are kept and marked.

## Development

```sh
npm install
npm run compile      # or: npm run watch
npm test             # parser tests, plain Node, no Extension Host needed
npm run icon         # re-render media/icon.png from the brand values
npm run package      # build a .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

The code is laid out as `src/claude` (reading transcripts), `src/store` (indexing, caching, search)
and `src/ui` (tree, panel, export), with the webview front end in `media/`.

## Acknowledgements

The idea of a Claude Code history browser for VS Code is not original to this extension —
[Claude Code History](https://marketplace.visualstudio.com/items?itemName=doorsofperception.claude-code-history)
by doorsofperception got there first. This is an independent implementation, written against the
current Claude Code transcript format and released with every feature unlocked.

## License

MIT. See [LICENSE.txt](https://github.com/MethodoxTech/claude-code-sessions-history-vscode/blob/main/LICENSE.txt).

Built by [Methodox Technologies, Inc.](https://methodox.io)
