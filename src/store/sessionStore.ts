/**
 * The index of every Claude Code session on this machine.
 *
 * Scanning every transcript is expensive — a single long session can be tens of
 * megabytes — so results are cached on disk and keyed on the transcript's size
 * and modification time. A transcript that has not changed is never re-read.
 */

import * as fs from "fs";
import * as path from "path";

import { extractMatchContext, extractUserText, scanSessionMeta } from "../claude/parser";
import { extractAssistantText, isToolResultMessage, parseSession } from "../claude/parser";
import { readTranscript, STOP } from "../claude/jsonl";
import { projectsRoot } from "../claude/paths";
import {
	ApiMessage,
	ConversationMessage,
	SearchMatch,
	SessionMeta,
	SessionStats,
	ToolUseBlock,
} from "../claude/types";

/** Bumped whenever the cached shape of SessionMeta changes. */
const CACHE_VERSION = 3;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	/** null records a transcript that holds no messages, so it is not rescanned. */
	meta: SessionMeta | null;
}

interface PersistedCache {
	version: number;
	entries: [string, CacheEntry][];
}

interface TranscriptFile {
	filePath: string;
	projectDir: string;
	mtimeMs: number;
	size: number;
}

export interface ScanProgress {
	scanned: number;
	total: number;
	/** Transcripts actually re-read this pass, as opposed to served from cache. */
	parsed: number;
}

export interface DeepSearchOptions {
	includeToolCalls?: boolean;
	signal?: AbortSignal;
	onProgress?: (current: number, total: number) => void;
	onMatch?: (match: SearchMatch) => void;
}

export class SessionStore {
	private cache = new Map<string, CacheEntry>();
	private loaded: SessionMeta[] = [];
	private loading?: Promise<SessionMeta[]>;

	constructor(
		private readonly cachePath: string,
		private claudeHome: string
	) {
		this.loadCacheFromDisk();
	}

	/** Point the store at a different Claude Code home and drop stale results. */
	setClaudeHome(claudeHome: string): void {
		if (this.claudeHome === claudeHome) {
			return;
		}
		this.claudeHome = claudeHome;
		this.loaded = [];
		this.loading = undefined;
	}

	get projectsDirectory(): string {
		return projectsRoot(this.claudeHome);
	}

	/** Sessions from the last successful scan, without triggering a new one. */
	get sessions(): SessionMeta[] {
		return this.loaded;
	}

	/**
	 * Index every transcript, re-reading only the ones that changed.
	 *
	 * Concurrent callers share one scan; the tree view and the browser panel
	 * both refresh on startup and would otherwise duplicate the work.
	 */
	async load(onProgress?: (progress: ScanProgress) => void): Promise<SessionMeta[]> {
		if (this.loading) {
			return this.loading;
		}
		this.loading = this.scan(onProgress).finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}

	private async scan(onProgress?: (progress: ScanProgress) => void): Promise<SessionMeta[]> {
		const files = this.listTranscripts();
		const sessions: SessionMeta[] = [];
		const seen = new Set<string>();
		let dirty = false;
		let parsed = 0;

		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			seen.add(file.filePath);

			const cached = this.cache.get(file.filePath);
			if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
				if (cached.meta) {
					sessions.push(cached.meta);
				}
				onProgress?.({ scanned: index + 1, total: files.length, parsed });
				continue;
			}

			try {
				const meta = await scanSessionMeta(file.filePath, file.projectDir, file.size);
				this.cache.set(file.filePath, {
					mtimeMs: file.mtimeMs,
					size: file.size,
					meta: meta ?? null,
				});
				dirty = true;
				parsed++;
				if (meta) {
					sessions.push(meta);
				}
			} catch {
				// An unreadable transcript should not take down the whole scan.
			}

			onProgress?.({ scanned: index + 1, total: files.length, parsed });
		}

		// Drop cache entries for transcripts that no longer exist.
		for (const key of Array.from(this.cache.keys())) {
			if (!seen.has(key)) {
				this.cache.delete(key);
				dirty = true;
			}
		}

		if (dirty) {
			this.saveCacheToDisk();
		}

		sessions.sort((a, b) => Date.parse(b.lastTimestamp) - Date.parse(a.lastTimestamp));
		this.loaded = sessions;
		return sessions;
	}

	/** Every `.jsonl` under `projects/`, with the stat data the cache keys on. */
	private listTranscripts(): TranscriptFile[] {
		const root = this.projectsDirectory;
		const files: TranscriptFile[] = [];

		let projectDirs: string[];
		try {
			projectDirs = fs.readdirSync(root);
		} catch {
			return files;
		}

		for (const projectDir of projectDirs) {
			const projectPath = path.join(root, projectDir);
			let entries: fs.Dirent[];
			try {
				if (!fs.statSync(projectPath).isDirectory()) {
					continue;
				}
				entries = fs.readdirSync(projectPath, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) {
					continue;
				}
				const filePath = path.join(projectPath, entry.name);
				try {
					const stat = fs.statSync(filePath);
					files.push({ filePath, projectDir, mtimeMs: stat.mtimeMs, size: stat.size });
				} catch {
					// Vanished between readdir and stat.
				}
			}
		}

		return files;
	}

	/** Full message list for one session. */
	async openSession(
		filePath: string,
		options: { toolOutputLimit?: number; includeSidechains?: boolean } = {}
	): Promise<ConversationMessage[]> {
		return parseSession(filePath, options);
	}

	/** Fast filter over indexed metadata only. */
	filter(sessions: SessionMeta[], query: string): SessionMeta[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return sessions;
		}
		return sessions.filter((session) => {
			return (
				session.title?.toLowerCase().includes(needle) ||
				session.preview.toLowerCase().includes(needle) ||
				session.projectPath.toLowerCase().includes(needle) ||
				session.projectName.toLowerCase().includes(needle) ||
				session.gitBranch?.toLowerCase().includes(needle) ||
				session.id.toLowerCase().includes(needle)
			);
		});
	}

	/**
	 * Search the body of every message in every session.
	 *
	 * Results are reported through `onMatch` as they are found rather than
	 * collected, so the UI can fill in while a long search is still running.
	 */
	async deepSearch(query: string, options: DeepSearchOptions = {}): Promise<SearchMatch[]> {
		const { includeToolCalls = false, signal, onProgress, onMatch } = options;
		const needle = query.trim().toLowerCase();
		const matches: SearchMatch[] = [];
		if (!needle) {
			return matches;
		}

		const files = this.listTranscripts();
		const metaByPath = new Map(this.loaded.map((session) => [session.filePath, session]));

		for (let index = 0; index < files.length; index++) {
			if (signal?.aborted) {
				return matches;
			}
			const file = files[index];
			onProgress?.(index + 1, files.length);

			let meta = metaByPath.get(file.filePath);
			if (!meta) {
				const cached = this.cache.get(file.filePath);
				meta = cached?.meta ?? undefined;
			}
			if (!meta) {
				// A session indexed since the last scan; index it now so the
				// result row has a title and a project to show.
				try {
					meta = await scanSessionMeta(file.filePath, file.projectDir, file.size);
				} catch {
					continue;
				}
				if (!meta) {
					continue;
				}
			}

			let messageIndex = 0;
			await readTranscript(
				file.filePath,
				(record) => {
					if (signal?.aborted) {
						return STOP;
					}
					const message = record.message as ApiMessage | undefined;

					if (record.type === "user" && message?.role === "user") {
						if (isToolResultMessage(message.content)) {
							return;
						}
						const text = extractUserText(message.content);
						if (!text) {
							return;
						}
						if (text.toLowerCase().includes(needle)) {
							const match: SearchMatch = {
								meta: meta!,
								messageIndex,
								role: "user",
								matchText: extractMatchContext(text, query),
								timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
							};
							matches.push(match);
							onMatch?.(match);
						}
						messageIndex++;
						return;
					}

					if (record.type === "assistant" && message?.role === "assistant") {
						const text = extractAssistantText(message.content);
						if (text.toLowerCase().includes(needle)) {
							const match: SearchMatch = {
								meta: meta!,
								messageIndex,
								role: "assistant",
								matchText: extractMatchContext(text, query),
								timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
							};
							matches.push(match);
							onMatch?.(match);
						}
						if (includeToolCalls && Array.isArray(message.content)) {
							for (const block of message.content) {
								if (block?.type !== "tool_use") {
									continue;
								}
								const toolUse = block as ToolUseBlock;
								let serialized: string;
								try {
									serialized = JSON.stringify(toolUse.input);
								} catch {
									continue;
								}
								if (serialized && serialized.toLowerCase().includes(needle)) {
									const match: SearchMatch = {
										meta: meta!,
										messageIndex,
										role: "tool",
										matchText: `${toolUse.name}: ${extractMatchContext(serialized, query)}`,
										timestamp:
											typeof record.timestamp === "string" ? record.timestamp : undefined,
									};
									matches.push(match);
									onMatch?.(match);
								}
							}
						}
						messageIndex++;
					}
					return;
				},
				{ signal }
			);
		}

		return matches;
	}

	/** Distinct project paths across the indexed sessions, sorted by name. */
	projects(sessions: SessionMeta[] = this.loaded): { path: string; name: string; count: number }[] {
		const byPath = new Map<string, { path: string; name: string; count: number }>();
		for (const session of sessions) {
			const existing = byPath.get(session.projectPath);
			if (existing) {
				existing.count++;
			} else {
				byPath.set(session.projectPath, {
					path: session.projectPath,
					name: session.projectName,
					count: 1,
				});
			}
		}
		return Array.from(byPath.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	computeStats(sessions: SessionMeta[] = this.loaded): SessionStats {
		let totalMessages = 0;
		let totalToolCalls = 0;
		let totalSizeBytes = 0;
		let totalTokens = 0;

		const daily = new Map<string, { count: number; messages: number }>();
		const byModel = new Map<string, number>();
		const byProject = new Map<string, { name: string; count: number; messages: number }>();
		const byBranch = new Map<string, number>();
		let longest: SessionMeta | undefined;

		for (const session of sessions) {
			totalMessages += session.messageCount;
			totalToolCalls += session.toolCallCount;
			totalSizeBytes += session.fileSize;
			totalTokens += session.totalTokens || 0;

			const date = session.timestamp.slice(0, 10);
			const day = daily.get(date) || { count: 0, messages: 0 };
			day.count++;
			day.messages += session.messageCount;
			daily.set(date, day);

			for (const model of session.models.length > 0 ? session.models : ["Unknown"]) {
				byModel.set(model, (byModel.get(model) || 0) + 1);
			}

			const project = byProject.get(session.projectPath) || {
				name: session.projectName,
				count: 0,
				messages: 0,
			};
			project.count++;
			project.messages += session.messageCount;
			byProject.set(session.projectPath, project);

			if (session.gitBranch) {
				byBranch.set(session.gitBranch, (byBranch.get(session.gitBranch) || 0) + 1);
			}

			if (!longest || session.messageCount > longest.messageCount) {
				longest = session;
			}
		}

		const dailyFrequency: SessionStats["dailyFrequency"] = [];
		const today = new Date();
		for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
			const date = new Date(today.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
			const day = daily.get(date);
			dailyFrequency.push({ date, count: day?.count || 0, messages: day?.messages || 0 });
		}

		let busiestDay: SessionStats["busiestDay"] = null;
		for (const [date, day] of daily) {
			if (!busiestDay || day.count > busiestDay.count) {
				busiestDay = { date, count: day.count };
			}
		}

		const totalSessions = sessions.length;
		const modelDistribution = Array.from(byModel.entries())
			.map(([model, count]) => ({
				model,
				count,
				percentage: totalSessions > 0 ? Math.round((count / totalSessions) * 100) : 0,
			}))
			.sort((a, b) => b.count - a.count);

		const projectActivity = Array.from(byProject.entries())
			.map(([projectPath, data]) => ({
				project: projectPath,
				name: data.name,
				count: data.count,
				messages: data.messages,
			}))
			.sort((a, b) => b.count - a.count)
			.slice(0, 12);

		const branchActivity = Array.from(byBranch.entries())
			.map(([branch, count]) => ({ branch, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		const timestamps = sessions.map((session) => session.timestamp).sort();

		return {
			totalSessions,
			totalMessages,
			totalToolCalls,
			totalSizeBytes,
			totalTokens,
			averageMessageCount: totalSessions > 0 ? Math.round(totalMessages / totalSessions) : 0,
			dailyFrequency,
			modelDistribution,
			projectActivity,
			branchActivity,
			busiestDay,
			longestSession: longest
				? {
						id: longest.id,
						filePath: longest.filePath,
						title: longest.title || longest.preview.slice(0, 80),
						messageCount: longest.messageCount,
					}
				: null,
			firstSession: timestamps[0],
			lastSession: timestamps[timestamps.length - 1],
		};
	}

	/** Forget every cached result, so the next load re-reads all transcripts. */
	clearCache(): void {
		this.cache.clear();
		this.loaded = [];
		try {
			fs.unlinkSync(this.cachePath);
		} catch {
			// Already absent.
		}
	}

	private loadCacheFromDisk(): void {
		try {
			const raw = fs.readFileSync(this.cachePath, "utf8");
			const parsed = JSON.parse(raw) as PersistedCache;
			if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
				return;
			}
			for (const [filePath, entry] of parsed.entries) {
				if (entry && typeof entry.mtimeMs === "number") {
					this.cache.set(filePath, entry);
				}
			}
		} catch {
			// No cache yet, or it is unreadable — start cold.
		}
	}

	private saveCacheToDisk(): void {
		const payload: PersistedCache = {
			version: CACHE_VERSION,
			entries: Array.from(this.cache.entries()),
		};
		try {
			fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
			// Write through a temporary file so a crash mid-write cannot leave
			// a truncated cache that fails to parse on the next start.
			const temporary = this.cachePath + ".tmp";
			fs.writeFileSync(temporary, JSON.stringify(payload), "utf8");
			fs.renameSync(temporary, this.cachePath);
		} catch {
			// Losing the cache costs a rescan, nothing more.
		}
	}
}
