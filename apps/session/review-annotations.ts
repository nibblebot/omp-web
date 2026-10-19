import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
	formatCodeReviewAnnotations,
	buildReviewPrompt,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/prompt";
import { createResolvedReviewTarget } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/target";
import { buildTextReviewPrompt } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-review";
import type {
	CodeReviewAnnotation,
	TextReviewAnnotation,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import type { ReviewAnchor, ReviewAnnotationDto } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

export const REVIEW_ANNOTATION_CUSTOM_TYPE = "web_review_annotation";
const run = promisify(execFile);
export function reviewContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
type StoredAnnotation = {
	annotation: ReviewAnnotationDto;
	content: string;
	rawDiff?: string;
	removed?: boolean;
};
function refusal(code: "stale" | "not_eligible", message: string): Error {
	return Object.assign(new Error(message), { code });
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Review arguments must be an object");
	return value as Record<string, unknown>;
}
function validateAnchor(value: unknown): ReviewAnchor {
	const anchor = object(value);
	if (anchor.kind === "entry") {
		const target = object(anchor.anchor);
		if (
			![target.sessionId, target.entryId, target.revision].every(
				(v) => typeof v === "string" && v.length > 0,
			)
		)
			throw new Error("Entry anchor requires sessionId, entryId and revision");
	} else if (anchor.kind === "text") {
		if (typeof anchor.text !== "string" || typeof anchor.contentHash !== "string")
			throw new Error("Text anchor requires text and contentHash");
	} else if (anchor.kind === "file" || anchor.kind === "diff") {
		if (
			typeof anchor.path !== "string" ||
			!anchor.path ||
			typeof anchor.contentHash !== "string" ||
			!Number.isInteger(anchor.start) ||
			!Number.isInteger(anchor.end) ||
			(anchor.start as number) < 1 ||
			(anchor.end as number) < (anchor.start as number)
		)
			throw new Error("File anchor requires path, contentHash and a positive line range");
		if (
			anchor.kind === "diff" &&
			(![anchor.repositoryId, anchor.base, anchor.head].every(
				(v) => typeof v === "string" && v.length > 0,
			) ||
				!["old", "new"].includes(String(anchor.side)))
		)
			throw new Error("Diff anchor requires repositoryId, base, head and side");
	} else throw new Error("Unknown review anchor kind");
	return structuredClone(value) as ReviewAnchor;
}
function records(entry: SessionEntry): Map<string, StoredAnnotation> {
	const result = new Map<string, StoredAnnotation>();
	for (const item of entry.session.sessionManager.getBranch()) {
		if (item.type === "custom" && item.customType === REVIEW_ANNOTATION_CUSTOM_TYPE) {
			const data = item.data as StoredAnnotation | undefined;
			if (data?.annotation?.id) result.set(data.annotation.id, data);
		}
	}
	return result;
}
const GIT_TIMEOUT_MS = 10_000;
async function git(entry: SessionEntry, args: string[]): Promise<string> {
	return (
		await run("git", ["--no-optional-locks", ...args], {
			cwd: entry.cwd,
			maxBuffer: 16 * 1024 * 1024,
			timeout: GIT_TIMEOUT_MS,
		})
	).stdout;
}
/** Memoizes git probes within one listing: HEAD and shared base/head refs run once. */
function memoGit(entry: SessionEntry): (args: string[]) => Promise<string> {
	const memo = new Map<string, Promise<string>>();
	return (args) => {
		const key = args.join("\0");
		let out = memo.get(key);
		if (!out) {
			out = git(entry, args);
			memo.set(key, out);
		}
		return out;
	};
}
function messageText(message: unknown): string {
	const data = object(message);
	if (typeof data.content === "string") return data.content;
	if (Array.isArray(data.content))
		return data.content
			.map((part) =>
				part && typeof part === "object" && "text" in part && typeof part.text === "string"
					? part.text
					: "",
			)
			.join("\n");
	return JSON.stringify(message);
}
async function readAnchor(
	entry: SessionEntry,
	anchor: ReviewAnchor,
	read: GitRead = (args) => git(entry, args),
): Promise<{ content: string; drift: boolean } | null> {
	if (anchor.kind === "text") return { content: anchor.text, drift: false };
	if (anchor.kind === "entry") {
		if (anchor.anchor.sessionId !== entry.session.sessionManager.getSessionId()) return null;
		const item = entry.session.sessionManager
			.getBranch()
			.find((item) => item.id === anchor.anchor.entryId);
		if (!item) return null;
		const content = item.type === "message" ? messageText(item.message) : JSON.stringify(item);
		return { content, drift: reviewContentHash(content) !== anchor.anchor.revision };
	}
	let content: string;
	let drift = false;
	try {
		if (anchor.kind === "diff") {
			const base = (await read(["rev-parse", "--verify", `${anchor.base}^{commit}`])).trim();
			const head = (await read(["rev-parse", "--verify", `${anchor.head}^{commit}`])).trim();
			const liveHead = (await read(["rev-parse", "HEAD"])).trim();
			drift =
				head !== liveHead ||
				(anchor.base.length === 40 && base !== anchor.base) ||
				(anchor.head.length === 40 && head !== anchor.head);
			content =
				anchor.side === "old"
					? await read(["show", `${base}:${anchor.path}`])
					: await readFile(resolve(entry.cwd, anchor.path), "utf8");
		} else {
			const path = anchor.path.startsWith("local://")
				? await entry.session.sessionManager.getArtifactPath(anchor.path.slice(8))
				: resolve(entry.cwd, anchor.path);
			if (!path) return null;
			content = await readFile(path, "utf8");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || anchor.kind === "diff") return null;
		throw error;
	}
	const lines = content.split(/\r?\n/);
	if (anchor.start > lines.length || anchor.end > lines.length) return null;
	return { content: lines.slice(anchor.start - 1, anchor.end).join("\n"), drift };
}
type GitRead = (args: string[]) => Promise<string>;
async function display(
	entry: SessionEntry,
	record: StoredAnnotation,
	read: GitRead = (args) => git(entry, args),
): Promise<ReviewAnnotationDto> {
	const live = await readAnchor(entry, record.annotation.anchor, read);
	const anchor = record.annotation.anchor;
	const hash = anchor.kind === "entry" ? anchor.anchor.revision : anchor.contentHash;
	return {
		...structuredClone(record.annotation),
		status: !live
			? "orphaned"
			: live.drift || reviewContentHash(live.content) !== hash
				? "stale"
				: "current",
	};
}
export async function listReviewAnnotations(
	entry: SessionEntry,
	source?: ReviewAnnotationDto["source"],
): Promise<ReviewAnnotationDto[]> {
	// Sequential on purpose: diff anchors shell out to git, and fanning out would
	// spawn one git process per annotation at once.
	const read = memoGit(entry);
	const out: ReviewAnnotationDto[] = [];
	for (const record of [...records(entry).values()].filter(
		(record) => !record.removed && (!source || record.annotation.source === source),
	))
		out.push(await display(entry, record, read));
	return out;
}
function persist(entry: SessionEntry, record: StoredAnnotation): void {
	entry.session.sessionManager.appendCustomEntry(
		REVIEW_ANNOTATION_CUSTOM_TYPE,
		structuredClone(record),
	);
}
function current(entry: SessionEntry, input: Record<string, unknown>): StoredAnnotation {
	const record = records(entry).get(String(input.id));
	if (!record || record.removed)
		throw refusal("not_eligible", "Annotation no longer exists; refresh the review");
	if (input.revision !== record.annotation.revision)
		throw Object.assign(refusal("stale", "Annotation changed; refresh before editing"), {
			currentRevision: record.annotation.revision,
		});
	return structuredClone(record);
}
/** Trusted SDK integrations can record agent-authored feedback; browser RPCs always use operator. */
export async function createReviewAnnotation(
	entry: SessionEntry,
	input: { source: ReviewAnnotationDto["source"]; anchor: ReviewAnchor; note: string },
	author: ReviewAnnotationDto["author"] = "operator",
): Promise<ReviewAnnotationDto> {
	if (!["diff", "file", "message", "reply", "text", "plan"].includes(input.source))
		throw new Error("Unknown annotation source");
	if (typeof input.note !== "string" || !input.note.trim())
		throw new Error("Annotation note is required");
	const anchor = validateAnchor(input.anchor);
	const live = await readAnchor(entry, anchor);
	if (!live)
		throw refusal("not_eligible", "Anchor no longer exists; refresh and select existing content");
	const hash = anchor.kind === "entry" ? anchor.anchor.revision : anchor.contentHash;
	if (live.drift || reviewContentHash(live.content) !== hash)
		throw refusal("stale", "Anchor content changed; refresh before annotating");
	const record: StoredAnnotation = {
		annotation: {
			id: randomUUID(),
			author,
			source: input.source,
			anchor,
			note: input.note,
			revision: 1,
			status: "current",
			createdAt: Date.now(),
		},
		content: live.content,
	};
	if (anchor.kind === "diff")
		record.rawDiff = await git(entry, ["diff", anchor.base, anchor.head, "--", anchor.path]);
	persist(entry, record);
	return display(entry, record);
}

export function createAnnotationMethods(): Record<
	string,
	(entry: SessionEntry, args: unknown[]) => Promise<unknown>
> {
	return {
		annotationList: async (entry) => listReviewAnnotations(entry),
		annotationCreate: async (entry, args) => {
			return createReviewAnnotation(
				entry,
				object(args[0]) as unknown as Parameters<typeof createReviewAnnotation>[1],
			);
		},
		annotationRemove: async (entry, args) => {
			const record = current(entry, object(args[0]));
			record.removed = true;
			record.annotation.revision++;
			persist(entry, record);
			return { removed: true };
		},
		annotationCompose: async (entry, args) => {
			const input = object(args[0]);
			const intent = input.intent ?? "insert";
			if (!["insert", "submit", "github"].includes(String(intent)))
				throw new Error("Unknown annotation composition intent");
			if (intent === "github")
				throw refusal(
					"not_eligible",
					"GitHub posting requires an explicit pull-request destination, which this local review does not contain; use insert or submit",
				);
			if (
				!Array.isArray(input.ids) ||
				!input.ids.length ||
				!input.ids.every((id) => typeof id === "string")
			)
				throw new Error("Select annotations to compose");
			if (input.supplemental !== undefined && typeof input.supplemental !== "string")
				throw new Error("Supplemental instructions must be text");
			const all = records(entry);
			const selected = input.ids.map((id) => {
				const record = all.get(id);
				if (!record || record.removed)
					throw refusal("stale", "Selected annotation no longer exists; refresh");
				return record;
			});
			const prompts: string[] = [];
			const code: CodeReviewAnnotation[] = [];
			for (const record of selected) {
				const annotation = record.annotation;
				const anchor = annotation.anchor;
				if (anchor.kind === "diff" || anchor.kind === "file") {
					code.push({
						scope: "line",
						path: anchor.path,
						occurrence: 1,
						note: annotation.note,
						hunkHeader: `@@ anchored lines ${anchor.start}-${anchor.end} @@`,
						rawLine: record.content,
						...(anchor.kind === "diff" && anchor.side === "old"
							? { oldLine: anchor.start }
							: { newLine: anchor.start }),
					});
				} else {
					const source: TextReviewSource = {
						id: annotation.id,
						kind: "quote",
						label: `${annotation.source} annotation ${annotation.id}`,
						text: record.content,
					};
					const notes: TextReviewAnnotation[] = [{ scope: "text", note: annotation.note }];
					const prompt = buildTextReviewPrompt(source, notes);
					if (prompt) prompts.push(prompt);
				}
			}
			const formatted = formatCodeReviewAnnotations(code, {
				forReviewer: intent === "submit",
				supplementalInstructions: input.supplemental as string | undefined,
			});
			if (formatted) {
				if (intent === "submit" && code.length) {
					const diff = selected.filter((record) => record.annotation.anchor.kind === "diff");
					if (diff.length) {
						const rawDiff = [...new Set(diff.map((record) => record.rawDiff ?? ""))].join("\n");
						prompts.push(
							buildReviewPrompt(
								createResolvedReviewTarget(
									"commit",
									"Frozen anchored review",
									rawDiff,
									"No changes in the anchored range",
								),
								formatted,
							),
						);
					} else prompts.push(formatted);
				} else prompts.push(formatted);
			}
			const prompt = prompts.join("\n\n");
			const submitted = intent === "submit" ? await entry.session.prompt(prompt) : false;
			return { intent, prompt, submitted };
		},
	};
}
