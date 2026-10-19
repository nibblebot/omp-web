import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	isAdvisorTranscriptName,
} from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { formatSessionDumpText } from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { SessionEntry } from "./session-entry";

export interface AdvisorHistoryOptions {
	compact?: boolean;
	fromByte?: number;
	maxBytes?: number;
	raw?: boolean;
	confirmSensitive?: boolean;
	/** Echo the preceding page's identity; a changed transcript requires starting over. */
	sourceId?: string;
}

export interface AdvisorHistoryProvenance {
	advisor: string;
	severity: "note" | "concern" | "blocker";
	toolCallId: string;
	/** Tool-call provenance is not proof that the emission guard delivered the note. */
	kind: "advise-call";
}

export interface AdvisorHistoryDto {
	available: boolean;
	text: string | null;
	compact: boolean;
	nextByte: number;
	totalBytes: number;
	hasMore: boolean;
	source: "live" | "durable";
	sourceId?: string;
	provenance: AdvisorHistoryProvenance[];
	warning?: string;
	reason?: string;
}

const DEFAULT_PAGE_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_PROVENANCE = 128;
const SENSITIVE_WARNING =
	"Advisor transcripts may contain private prompts, reasoning, tool inputs, tool outputs, and secrets. Do not share without review.";

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function provenanceOf(messages: readonly unknown[], advisor: string): AdvisorHistoryProvenance[] {
	const result: AdvisorHistoryProvenance[] = [];
	for (const value of messages) {
		const message = object(value);
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const value of message.content) {
			const part = object(value);
			const args = object(part?.arguments);
			if (
				part?.type !== "toolCall" ||
				part.name !== "advise" ||
				typeof part.id !== "string" ||
				typeof args?.note !== "string"
			)
				continue;
			result.push({
				advisor,
				toolCallId: part.id,
				kind: "advise-call",
				severity:
					args.severity === "blocker"
						? "blocker"
						: args.severity === "concern"
							? "concern"
							: "note",
			});
			if (result.length > MAX_PROVENANCE) return result;
		}
	}
	return result;
}

interface AdvisorTranscriptFile {
	name: string;
	path: string;
	stat: Stats;
}

interface DurableAdvisorRender {
	fingerprint: string;
	text: string;
	sections: number;
	provenance: AdvisorHistoryProvenance[];
	warnings: string[];
	derived?: { sourceId: string; bytes: Buffer };
}

// Durable renders are keyed by session, transcript root, and format. Any change
// to advisor file names, sizes, mtimes, or inodes invalidates the entry.
const DURABLE_RENDER_CACHE_LIMIT = 8;
const durableRenders = new Map<string, DurableAdvisorRender>();

async function statAdvisorTranscripts(root: string): Promise<AdvisorTranscriptFile[]> {
	const names = (await readdir(root, { withFileTypes: true }))
		.filter((file) => file.isFile() && isAdvisorTranscriptName(file.name))
		.map((file) => file.name)
		.sort((a, b) => a.localeCompare(b));
	const files: AdvisorTranscriptFile[] = [];
	for (const name of names) {
		const path = join(root, name);
		const stat = await lstat(path);
		if (stat.isFile() && !stat.isSymbolicLink()) files.push({ name, path, stat });
	}
	return files;
}

async function renderDurableAdvisors(
	files: readonly AdvisorTranscriptFile[],
	compact: boolean,
	fingerprint: string,
): Promise<DurableAdvisorRender> {
	const sections: string[] = [];
	const provenance: AdvisorHistoryProvenance[] = [];
	const warnings: string[] = [];
	for (const file of files) {
		let validHeader: boolean | undefined;
		let malformed = false;
		const messages: AgentMessage[] = [];
		await visitEntriesFromFileStream(
			file.path,
			(value) => {
				const record = object(value);
				if (validHeader === undefined) {
					validHeader = record?.type === "session" && typeof record.id === "string";
					return;
				}
				if (!validHeader || record?.type !== "message") return;
				const message = object(record.message);
				if (message && ["assistant", "user", "toolResult"].includes(String(message.role)))
					messages.push(message as unknown as AgentMessage);
			},
			{
				maxBytes: file.stat.size,
				throwIfMissing: true,
				onMalformedRecord: () => {
					malformed = true;
				},
			},
		);
		if (!validHeader) {
			warnings.push("An invalid advisor transcript header was skipped.");
			continue;
		}
		if (malformed)
			warnings.push(
				"Malformed or incomplete advisor JSONL records were skipped by the SDK reader.",
			);
		const advisor =
			file.name === ADVISOR_TRANSCRIPT_FILENAME
				? "default"
				: file.name.slice("__advisor.".length, -".jsonl".length);
		const rendered = compact
			? formatSessionHistoryMarkdown(messages)
			: formatSessionDumpText({ messages });
		sections.push(`### Advisor: ${advisor}\n\n${rendered}`);
		if (provenance.length <= MAX_PROVENANCE) provenance.push(...provenanceOf(messages, advisor));
	}
	return {
		fingerprint,
		text: sections.join("\n\n"),
		sections: sections.length,
		provenance,
		warnings,
	};
}

function rememberDurableRender(key: string, render: DurableAdvisorRender): DurableAdvisorRender {
	durableRenders.delete(key);
	durableRenders.set(key, render);
	if (durableRenders.size > DURABLE_RENDER_CACHE_LIMIT) {
		const oldest = durableRenders.keys().next().value;
		if (oldest !== undefined) durableRenders.delete(oldest);
	}
	return render;
}

function deriveTranscriptDigest(
	sessionId: string,
	sessionFile: string,
	source: AdvisorHistoryDto["source"],
	compact: boolean,
	text: string,
): { sourceId: string; bytes: Buffer } {
	const sourceId = createHash("sha256")
		.update(`${sessionId}\0${sessionFile}\0${source}\0${compact}\0`)
		.update(text)
		.digest("hex");
	return { sourceId, bytes: Buffer.from(text, "utf8") };
}

/**
 * Read the actual SDK transcript. Offsets address the UTF-8 SDK-rendered text,
 * not JSONL bytes. Default output is a bounded compact page, never a raw dump.
 * Durable discovery mirrors AdvisorTranscriptRecorder/loadAdvisorTranscriptCosts:
 * only direct __advisor*.jsonl children of the server-owned session-file stem.
 * getArtifactsDir is deliberately NOT used: workers share their parent's root.
 */
export async function readAdvisorHistory(
	entry: SessionEntry,
	opts: AdvisorHistoryOptions = {},
): Promise<AdvisorHistoryDto> {
	const compact = opts.compact ?? !opts.raw;
	let source: AdvisorHistoryDto["source"] = "live";
	const unavailable = (reason: string): AdvisorHistoryDto => ({
		available: false,
		text: null,
		compact,
		nextByte: 0,
		totalBytes: 0,
		hasMore: false,
		source,
		provenance: [],
		reason,
		warning: SENSITIVE_WARNING,
	});
	// compact:false is itself a sensitive raw-format request, not a bypass.
	if ((opts.raw === true || !compact) && opts.confirmSensitive !== true)
		return unavailable("raw advisor history requires explicit sensitive confirmation");
	if (opts.fromByte !== undefined && (!Number.isSafeInteger(opts.fromByte) || opts.fromByte < 0))
		return unavailable("invalid byte offset");
	if (opts.maxBytes !== undefined && (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 4))
		return unavailable("page size must be an integer of at least four bytes");
	const maxBytes = Math.min(opts.maxBytes ?? DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES);
	const sessionFile = entry.session.sessionManager.getSessionFile();
	const sessionId = entry.session.sessionManager.getSessionId();
	let text: string | null = null;
	let durable: DurableAdvisorRender | null = null;
	let provenance: AdvisorHistoryProvenance[] = [];
	const warnings = [SENSITIVE_WARNING];
	try {
		const agent = entry.session.getAdvisorAgent();
		if (agent) {
			text = entry.session.formatAdvisorHistoryAsText({ compact });
			const names = entry.session.getAdvisorStatusOverview().advisors;
			provenance = provenanceOf(agent.state.messages, names[0]?.name ?? "default");
			if (names.length > 1)
				warnings.push(
					"Live provenance covers the first SDK-exposed advisor only; the text includes all live advisors.",
				);
		}
		if (text === null) {
			source = "durable";
			if (!sessionFile?.endsWith(".jsonl")) return unavailable("no persisted advisor transcript");
			const root = sessionFile.slice(0, -".jsonl".length);
			const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (!rootStat) return unavailable("no persisted advisor transcript");
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
				return unavailable("advisor artifact root is not an owned directory");
			const files = await statAdvisorTranscripts(root);
			const fingerprint = files
				.map((file) => `${file.name}\0${file.stat.size}\0${file.stat.mtimeMs}\0${file.stat.ino}`)
				.join("\n");
			const cacheKey = `${sessionId}\0${sessionFile}\0${compact}`;
			const cached = durableRenders.get(cacheKey);
			const render =
				cached?.fingerprint === fingerprint
					? cached
					: rememberDurableRender(
							cacheKey,
							await renderDurableAdvisors(files, compact, fingerprint),
						);
			if (render.sections === 0) return unavailable("no persisted advisor transcript");
			durable = render;
			text = render.text;
			provenance = render.provenance;
			warnings.push(...render.warnings);
			if (!compact)
				warnings.push(
					"Durable recorder files contain finalized messages only; original system prompt, tool inventory, and configuration are not persisted by the recorder.",
				);
		}
	} catch {
		return unavailable("advisor transcript could not be read");
	}
	// A session transition must not expose the previous session's snapshot.
	if (
		entry.session.sessionManager.getSessionFile() !== sessionFile ||
		entry.session.sessionManager.getSessionId() !== sessionId
	)
		return unavailable("advisor history target changed; restart paging");
	const derived =
		durable?.derived ?? deriveTranscriptDigest(sessionId, sessionFile ?? "", source, compact, text);
	if (durable) durable.derived = derived;
	const { sourceId, bytes } = derived;
	if (opts.sourceId !== undefined && opts.sourceId !== sourceId)
		return unavailable("advisor history changed; restart paging");
	let start = Math.min(opts.fromByte ?? 0, bytes.length);
	// A foreign cursor inside a code point skips to the next complete character.
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	let end = Math.min(start + maxBytes, bytes.length);
	while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
	if (provenance.length > MAX_PROVENANCE)
		warnings.push(
			"Provenance is limited to the first 128 advise calls; consult the transcript for additional calls.",
		);
	return {
		available: true,
		text: bytes.subarray(start, end).toString("utf8"),
		compact,
		nextByte: end,
		totalBytes: bytes.length,
		hasMore: end < bytes.length,
		source,
		sourceId,
		provenance: provenance.slice(0, MAX_PROVENANCE),
		warning: warnings.join(" "),
		...(start === bytes.length ? { reason: "end" } : {}),
	};
}
