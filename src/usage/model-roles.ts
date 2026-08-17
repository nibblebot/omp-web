/**
 * Resolved model-role roster for the corner pet. Pure grouping + label logic;
 * primary/secondary styling is decided by the caller (Pet.tsx).
 */

/** One distinct role model: its provider/id plus every role it serves. */
export interface RoleGroup {
	provider: string;
	id: string;
	roles: string[];
}

/**
 * Groups resolved model roles by provider/id, preserving first-seen order —
 * the wire carries canonical role order, so the default model's group leads.
 * `active` is accepted for symmetry with the caller's primary-row decision,
 * but nothing is marked here; the caller decides which group is primary.
 */
export function groupModelRoles(
	modelRoles: Array<{ role: string; provider: string; id: string }> | undefined,
	active: { provider?: string; id?: string } | undefined,
): RoleGroup[] {
	if (!modelRoles || modelRoles.length === 0) return [];
	const groups: RoleGroup[] = [];
	const byKey = new Map<string, RoleGroup>();
	for (const entry of modelRoles) {
		const key = `${entry.provider}/${entry.id}`;
		let group = byKey.get(key);
		if (!group) {
			group = { provider: entry.provider, id: entry.id, roles: [] };
			byKey.set(key, group);
			groups.push(group);
		}
		group.roles.push(entry.role);
	}
	return groups;
}
