import { fetchFsBrowse, type FsBrowseDir, type FsBrowseResult } from "../store/projects";

/**
 * Browse-state module behind the Add project folder chooser
 * (AddProjectDialog.tsx). Pure logic, no JSX, no Solid: the component
 * subscribes and re-renders off snapshots. All fetching goes through
 * fetchFsBrowse (GET /ctl/fs/browse on the fleet edge); `~`/`~/…` are passed
 * through verbatim and expanded server-side.
 *
 * hasGit of the CURRENT directory is not part of the browse answer (only
 * listed children carry it), so it is known only when the current path was
 * reached by opening a listing row: navigate(path, { hasGit }) records it;
 * up()/manual/initial navigation leaves it null (unknown, since the server stays
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
	/** Path of the listed child picked by single click; null when none. Cleared by every navigation. */
	selected: string | null;
}

/** The folder Add project would register: the selected child, else the current directory. */
export interface AddTarget {
	path: string;
	/** null when the git bit is unknown (current directory reached without a listing row). */
	hasGit: boolean | null;
}

export interface PathCrumb {
	label: string;
	path: string;
}

export interface DirPicker {
	state(): DirPickerState;
	/** Re-render hook for the Solid component; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Browse `path` (absolute, "~", "~/rel"; omitted → the fleet host's home
	 *  dir). `opts.hasGit` records the target's git bit when the caller knows
	 *  it (listing-row open). Clears the selection. */
	navigate(path?: string, opts?: { hasGit?: boolean }): Promise<void>;
	/** Pick a listed child (single click), or clear the pick with null. */
	select(path: string | null): void;
	/** Browse the parent of the current listing; no-op at the filesystem root
	 *  or before the first load. */
	up(): Promise<void>;
	/** Re-list the current directory, preserving its known hasGit bit. */
	refresh(): Promise<void>;
}

/** Add-project target for a snapshot: the selected child when it is still listed, else the current directory; null before the first load. */
export function addTarget(st: DirPickerState): AddTarget | null {
	if (st.selected !== null) {
		const dir = st.dirs.find((d) => d.path === st.selected);
		if (dir) return { path: dir.path, hasGit: dir.hasGit };
	}
	if (st.currentPath === "") return null;
	return { path: st.currentPath, hasGit: st.hasGit };
}

/** Breadcrumb segments for a canonical absolute path: "/" then each ancestor. */
export function pathCrumbs(path: string): PathCrumb[] {
	if (path === "") return [];
	const crumbs: PathCrumb[] = [{ label: "/", path: "/" }];
	let acc = "";
	for (const part of path.split("/").filter(Boolean)) {
		acc += `/${part}`;
		crumbs.push({ label: part, path: acc });
	}
	return crumbs;
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
		selected: null,
	};
	// Latest-wins: only the most recent navigate applies its result (or error);
	// a slow earlier answer must not clobber a newer listing.
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
				selected: null,
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
		select: (path) => set({ selected: path }),
		up: () =>
			st.parent === null || st.currentPath === "" ? Promise.resolve() : navigate(st.parent),
		refresh: () =>
			st.currentPath === ""
				? Promise.resolve()
				: navigate(st.currentPath, { hasGit: st.hasGit ?? undefined }),
	};
}
