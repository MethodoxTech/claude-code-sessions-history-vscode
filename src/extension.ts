/**
 * Claude Code Sessions History — entry point.
 *
 * Everything the extension shows comes from the JSON Lines transcripts Claude
 * Code already writes under its home directory. Nothing is sent anywhere, and
 * nothing is written back into that directory.
 */

import * as path from "path";
import * as vscode from "vscode";

import { BookmarkStore } from "./store/bookmarks";
import { BrowserPanel } from "./ui/browserPanel";
import { SessionStore } from "./store/sessionStore";
import { SessionMeta } from "./claude/types";
import { SessionTreeItem, SessionTreeProvider } from "./ui/sessionTree";
import { exportRange, exportSession, promptForRange, resumeSession } from "./ui/actions";
import { fileExists, resolveClaudeHome } from "./claude/paths";

export function activate(context: vscode.ExtensionContext): void {
	const claudeHome = currentClaudeHome();
	const store = new SessionStore(
		path.join(context.globalStorageUri.fsPath, "session-index.json"),
		claudeHome
	);
	const bookmarks = new BookmarkStore(context.globalState);
	const tree = new SessionTreeProvider(store, bookmarks);

	const view = vscode.window.createTreeView("claudeSessions.tree", {
		treeDataProvider: tree,
		showCollapseAll: true,
	});

	context.subscriptions.push(view, bookmarks);
	void vscode.commands.executeCommand("setContext", "claudeSessions.bookmarksOnly", false);

	context.subscriptions.push(bookmarks.onDidChange(() => tree.refresh()));

	// === Commands ===

	const register = (id: string, handler: (...args: never[]) => unknown): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand(id, handler as (...args: unknown[]) => unknown)
		);
	};

	register("claudeSessions.openBrowser", () => {
		BrowserPanel.show(context, store, bookmarks);
	});

	register("claudeSessions.openSession", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (session) {
			BrowserPanel.show(context, store, bookmarks, session);
		}
	});

	register("claudeSessions.refresh", async () => {
		tree.refresh();
		await BrowserPanel.current?.refresh();
	});

	register("claudeSessions.rescan", async () => {
		store.clearCache();
		tree.refresh();
		await BrowserPanel.current?.refresh();
		void vscode.window.showInformationMessage("Rescanning every transcript.");
	});

	register("claudeSessions.search", async () => {
		const query = await vscode.window.showInputBox({
			title: "Filter sessions",
			prompt: "Match a title, first message, project or branch. Leave empty to clear.",
			value: tree.filter,
		});
		if (query === undefined) {
			return;
		}
		tree.setFilter(query);
		view.description = query ? `filtered: ${query}` : undefined;
	});

	register("claudeSessions.toggleBookmarkFilter", () => {
		tree.setBookmarksOnly(true);
	});

	register("claudeSessions.clearBookmarkFilter", () => {
		tree.setBookmarksOnly(false);
	});

	register("claudeSessions.groupByDate", async () => {
		await setGroupBy("date");
		tree.refresh();
	});

	register("claudeSessions.groupByProject", async () => {
		await setGroupBy("project");
		tree.refresh();
	});

	register("claudeSessions.toggleBookmark", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (session) {
			await bookmarks.toggle(session.id);
		}
	});

	register("claudeSessions.removeBookmark", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (session) {
			await bookmarks.remove(session.id);
		}
	});

	register("claudeSessions.resume", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target) ?? (await pickSession(store, "Resume which session?"));
		if (session) {
			resumeSession(session);
		}
	});

	register("claudeSessions.exportMarkdown", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target) ?? (await pickSession(store, "Export which session?"));
		if (session) {
			await exportSession(store, session);
		}
	});

	register("claudeSessions.exportRange", async () => {
		const range = await promptForRange();
		if (range) {
			await exportRange(store, range.start, range.end);
		}
	});

	register("claudeSessions.showStats", () => {
		const panel = BrowserPanel.show(context, store, bookmarks);
		void panel;
		void vscode.commands.executeCommand("claudeSessions.openBrowser");
	});

	register("claudeSessions.copySessionId", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (session) {
			await vscode.env.clipboard.writeText(session.id);
			void vscode.window.showInformationMessage(`Copied ${session.id}`);
		}
	});

	register("claudeSessions.openTranscript", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (session) {
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(session.filePath));
		}
	});

	register("claudeSessions.revealTranscript", async (target?: SessionMeta | SessionTreeItem) => {
		const session = resolveSession(target);
		if (session) {
			await vscode.commands.executeCommand(
				"revealFileInOS",
				vscode.Uri.file(session.filePath)
			);
		}
	});

	register("claudeSessions.openProjectFolder", async (target?: { resourceUri?: vscode.Uri }) => {
		const folder = target?.resourceUri;
		if (!folder || !fileExists(folder.fsPath)) {
			void vscode.window.showWarningMessage("That project folder no longer exists.");
			return;
		}
		await vscode.commands.executeCommand("revealFileInOS", folder);
	});

	register("claudeSessions.openSettings", async () => {
		await vscode.commands.executeCommand(
			"workbench.action.openSettings",
			"@ext:methodox.claude-code-sessions-history"
		);
	});

	// === Reacting to the outside world ===

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration("claudeSessions.claudeHome")) {
				store.setClaudeHome(currentClaudeHome());
				tree.refresh();
				await BrowserPanel.current?.refresh();
			} else if (event.affectsConfiguration("claudeSessions.groupBy")) {
				tree.refresh();
			} else if (event.affectsConfiguration("claudeSessions.autoRefresh")) {
				watcher.reconfigure();
			}
		})
	);

	const watcher = new TranscriptWatcher(store, () => {
		tree.refresh();
		void BrowserPanel.current?.refresh();
	});
	context.subscriptions.push(watcher);
	watcher.reconfigure();
}

export function deactivate(): void {
	// Nothing to tear down beyond the disposables registered above.
}

function currentClaudeHome(): string {
	return resolveClaudeHome(
		vscode.workspace.getConfiguration("claudeSessions").get<string>("claudeHome", "")
	);
}

async function setGroupBy(value: "date" | "project"): Promise<void> {
	await vscode.workspace
		.getConfiguration("claudeSessions")
		.update("groupBy", value, vscode.ConfigurationTarget.Global);
}

function resolveSession(target?: SessionMeta | SessionTreeItem): SessionMeta | undefined {
	if (!target) {
		return undefined;
	}
	if (target instanceof SessionTreeItem) {
		return target.session;
	}
	return "filePath" in target ? target : undefined;
}

async function pickSession(store: SessionStore, title: string): Promise<SessionMeta | undefined> {
	const sessions = await store.load();
	if (sessions.length === 0) {
		void vscode.window.showWarningMessage("No Claude Code sessions found yet.");
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		sessions.map((session) => ({
			label: session.title || session.preview.slice(0, 80) || session.id,
			description: `${session.projectName} · ${session.messageCount} msgs`,
			detail: new Date(session.lastTimestamp).toLocaleString(),
			session,
		})),
		{ title, matchOnDescription: true, matchOnDetail: true }
	);

	return picked?.session;
}

/**
 * Watch the transcripts folder so the list keeps up with a running session.
 *
 * Claude Code appends to the active transcript continuously, so change events
 * are debounced hard; refreshing on every write would rescan constantly.
 */
class TranscriptWatcher implements vscode.Disposable {
	private watcher?: vscode.FileSystemWatcher;
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly store: SessionStore,
		private readonly onChange: () => void
	) {}

	reconfigure(): void {
		this.stop();
		const enabled = vscode.workspace
			.getConfiguration("claudeSessions")
			.get<boolean>("autoRefresh", true);
		if (!enabled) {
			return;
		}

		const pattern = new vscode.RelativePattern(this.store.projectsDirectory, "**/*.jsonl");
		this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const schedule = (): void => this.schedule();
		this.watcher.onDidCreate(schedule);
		this.watcher.onDidChange(schedule);
		this.watcher.onDidDelete(schedule);
	}

	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.onChange();
		}, 4000);
	}

	private stop(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.stop();
	}
}
