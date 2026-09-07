/**
 * Shared display helpers for the fleet log-store read surface (P8.5/P8.6).
 * Pure + module-private to the tx view: no fetch, no solid. Small presenters
 * exist so the sidebar list, the detail header and the transcript-list
 * coverage chips describe the same store facts in one voice.
 */
import type { StoredFileInfo, StoredWorkspaceProvenance } from "../api";

const KIND_LABELS: Record<string, string> = {
	main: "main",
	subagent: "subagent",
	advisor: "advisor",
	metadata: "metadata",
};

/** "clone · feature-x · profile p" — the workspace provenance line. */
export function provenanceLabel(p: StoredWorkspaceProvenance | undefined): string {
	if (!p) return "";
	const parts = [p.projectId, p.kind];
	if (p.profileId) parts.push(`profile ${p.profileId}`);
	if (p.branch) parts.push(p.branch);
	if (p.pinnedRevision) parts.push(p.pinnedRevision);
	if (p.sourceKind) parts.push(`source ${p.sourceKind}`);
	return parts.join(" · ");
}

const KIND_ORDER: readonly string[] = ["main", "subagent", "advisor", "metadata"];

/**
 * Files grouped by kind in the fixed main/subagent/advisor/metadata order,
 * preserving the server's order within a group. Any unknown kind is bucketed
 * into its own trailing group so nothing silently disappears.
 */
export function groupFilesByKind(files: readonly StoredFileInfo[]): {
	kind: string;
	label: string;
	files: StoredFileInfo[];
}[] {
	const buckets: Record<string, StoredFileInfo[]> = {};
	for (const f of files) {
		const list = buckets[f.kind];
		if (list) list.push(f);
		else buckets[f.kind] = [f];
	}
	const groups: { kind: string; label: string; files: StoredFileInfo[] }[] = [];
	for (const kind of KIND_ORDER) {
		const list = buckets[kind];
		if (list) groups.push({ kind, label: KIND_LABELS[kind] ?? kind, files: list });
	}
	for (const kind of Object.keys(buckets)) {
		if (!KIND_ORDER.includes(kind)) {
			groups.push({ kind, label: KIND_LABELS[kind] ?? kind, files: buckets[kind] });
		}
	}
	return groups;
}

/** Distinct file kinds present, for the per-kind counts summary. */
export function kindsSummary(kinds: Record<string, number>): { kind: string; count: number }[] {
	const out: { kind: string; count: number }[] = [];
	for (const kind of KIND_ORDER) {
		const count = kinds[kind];
		if (count && count > 0) out.push({ kind: KIND_LABELS[kind] ?? kind, count });
	}
	return out;
}
