import { fetchFsBrowse, type FsBrowseDir, type FsBrowseResult } from "../store/projects";

/**
 * Browse-state module behind the onboarding directory pickers
 * (DirPicker.tsx, embedded by AddProjectModal / WorktreeModal). Pure logic —
 * no JSX, no Solid: the component subscribes and re-renders off snapshots.
 * All fetching goes through fetchFsBrowse (GET /ctl/fs/browse on the fleet
 * edge); `~`/`~/…` are passed through verbatim and expanded server-side.
 *
 * hasGit of the CURRENT directory is not part of the browse answer (only
 * listed children carry it), so it is known only when the current path was
 * reached by clicking a listing row: navigate(path, { hasGit }) records it;
 * up()/manual/initial navigation leaves it null (unknown — the server stays
 * authoritative on submit either way).
 */

export type BrowseFn = (path?: string) => Promise<FsBrowseResult>;

export interface DirPickerState {
	/** Canonical path of the listing on screen; "" before the first load. */
	currentPath: string;
	parent: string | null;
	dirs: FsBrowseDir[];
	loading: boolean;
	error: string | null;
	truncated: boolean;
	/** hasGit of currentPath when known (reached via a listing row), else null. */
	hasGit: boolean | null;
}

export interface DirPicker {
	state(): DirPickerState;
	/** Re-render hook for the Solid component; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Browse `path` (absolute, "~", "~/rel"; omitted → the fleet host's home
	 *  dir). `opts.hasGit` records the target's git bit when the caller knows
	 *  it (listing-row click). */
	navigate(path?: string, opts?: { hasGit?: boolean }): Promise<void>;
	/** Browse the parent of the current listing; no-op at the filesystem root
	 *  or before the first load. */
	up(): Promise<void>;
	/** Re-list the current directory, preserving its known hasGit bit. */
	refresh(): Promise<void>;
}

export function createDirPicker(browse: BrowseFn = fetchFsBrowse): DirPicker {
	let st: DirPickerState = {
		currentPath: "",
		parent: null,
		dirs: [],
		loading: false,
		error: null,
		truncated: false,
		hasGit: null,
	};
	// Latest-wins: only the most recent navigate applies its result (or error)
	// — a slow earlier answer must not clobber a newer listing.
	let seq = 0;
	const listeners = new Set<() => void>();
	const set = (patch: Partial<DirPickerState>): void => {
		st = { ...st, ...patch };
		for (const l of listeners) l();
	};

	const navigate = async (path?: string, opts?: { hasGit?: boolean }): Promise<void> => {
		const ticket = ++seq;
		set({ loading: true, error: null });
		try {
			const res = await browse(path);
			if (ticket !== seq) return;
			set({
				currentPath: res.path,
				parent: res.parent,
				dirs: res.dirs,
				truncated: res.truncated,
				hasGit: opts?.hasGit ?? null,
				loading: false,
			});
		} catch (err) {
			if (ticket !== seq) return;
			// Keep the previous listing on screen; the error renders as a notice.
			set({ loading: false, error: err instanceof Error ? err.message : String(err) });
		}
	};

	return {
		state: () => st,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		navigate,
		up: () =>
			st.parent === null || st.currentPath === "" ? Promise.resolve() : navigate(st.parent),
		refresh: () =>
			st.currentPath === ""
				? Promise.resolve()
				: navigate(st.currentPath, { hasGit: st.hasGit ?? undefined }),
	};
}
