/** One OAuth provider as the relay lists it for the login dialog. */
export interface LoginProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

/** Providers after filtering, split into the signed-in group and everything else. */
export interface ProviderGroups {
	signedIn: LoginProvider[];
	available: LoginProvider[];
}

/**
 * Filter providers by a case-insensitive substring of name or id, then split
 * the signed-in providers (listed first) from the rest. Each group is sorted
 * by name so the 85-entry list reads in a stable order.
 */
export function groupProviders(providers: readonly LoginProvider[], query: string): ProviderGroups {
	const q = query.trim().toLowerCase();
	const matched = providers.filter(
		(p) => q === "" || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
	);
	const byName = (a: LoginProvider, b: LoginProvider) => a.name.localeCompare(b.name);
	return {
		signedIn: matched.filter((p) => p.authenticated).sort(byName),
		available: matched.filter((p) => !p.authenticated).sort(byName),
	};
}
