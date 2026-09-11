/**
 * Unit tests for the default workspace resource deleter
 * (fleet/workspace-resources.ts): provider-kind dispatch, and the containment
 * guards that keep a corrupted record or a symlinked state path from deleting
 * the managed root, a sibling workspace, or anything outside its state parent.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RegistryEntry, WorkspaceRecord } from "./registry";
import { createWorkspaceResourceDeleter } from "./workspace-resources";
import { cleanupTempDirs, tempDir } from "../shared/testkit";

afterAll(cleanupTempDirs);

/** Minimal entry for the deleter (only cwd + workspace are read). */
function makeEntry(overrides: Partial<RegistryEntry>): RegistryEntry {
	return {
		daemonId: "d1",
		name: "clone",
		cwd: "",
		project: "proj",
		projectId: "p1",
		labels: [],
		mode: "spawned",
		status: "asleep",
		registeredAt: 1,
		...overrides,
	};
}

function kubernetesWorkspace(identity: string): WorkspaceRecord {
	return {
		kind: "clone",
		projectId: "p1",
		desiredState: "stopped",
		profileId: "k8s",
		providerKind: "kubernetes",
		kubernetes: {
			resourceIdentity: identity,
			context: "minikube",
			namespace: "omp",
			namespaceUid: "namespace-uid-1",
		},
	};
}

function bwrapWorkspace(): WorkspaceRecord {
	return {
		kind: "clone",
		projectId: "p1",
		desiredState: "stopped",
		profileId: "local",
		providerKind: "bwrap",
	};
}

describe("workspace resource deleter", () => {
	test("kubernetes removes only the provider state dirs, never the volume", async () => {
		const root = join(tempDir("omp-wr-kube-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const identity = "2".repeat(32);
		const daemonId = "d1";
		const stateDir = join(root, ".kubernetes", identity);
		const legacyDir = join(root, ".provider-state", daemonId);
		const volume = join(root, daemonId);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "provider.json"), "{}\n");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "ops.jsonl"), "\n");
		mkdirSync(volume, { recursive: true });
		writeFileSync(join(volume, "keep.txt"), "keep\n");

		await createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
			daemonId,
			makeEntry({ daemonId, workspace: kubernetesWorkspace(identity) }),
		);

		expect(existsSync(stateDir)).toBe(false);
		expect(existsSync(legacyDir)).toBe(false);
		// The kubernetes volume is the PVC the provider already deleted.
		expect(existsSync(join(volume, "keep.txt"))).toBe(true);
	});

	test("bwrap removes its own volume and leaves sibling provider state alone", async () => {
		const root = join(tempDir("omp-wr-bwrap-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const daemonId = "d1";
		const volume = join(root, daemonId);
		mkdirSync(join(volume, ".checkout"), { recursive: true });
		writeFileSync(join(volume, ".checkout", "readme.md"), "hello\n");
		const otherState = join(root, ".kubernetes", "3".repeat(32));
		mkdirSync(otherState, { recursive: true });
		writeFileSync(join(otherState, "keep.json"), "{}\n");

		await createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
			daemonId,
			makeEntry({ daemonId, cwd: volume, workspace: bwrapWorkspace() }),
		);

		expect(existsSync(volume)).toBe(false);
		expect(existsSync(join(otherState, "keep.json"))).toBe(true);
	});

	test("a legacy record with no provider kind keeps the local-volume path", async () => {
		const root = join(tempDir("omp-wr-legacy-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const daemonId = "d1";
		const volume = join(root, daemonId);
		mkdirSync(join(volume, ".home"), { recursive: true });
		writeFileSync(join(volume, ".home", "sentinel"), "x\n");

		await createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
			daemonId,
			makeEntry({
				daemonId,
				cwd: volume,
				workspace: { kind: "clone", projectId: "p1", desiredState: "stopped", profileId: "local" },
			}),
		);

		expect(existsSync(volume)).toBe(false);
	});

	test("a placeholder workspace with no volume is a no-op", async () => {
		const root = join(tempDir("omp-wr-placeholder-"), "workspaces");
		mkdirSync(root, { recursive: true });
		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"d1",
				makeEntry({ daemonId: "d1", workspace: bwrapWorkspace() }),
			),
		).resolves.toBeUndefined();
	});

	test("the local-volume path refuses a volume outside the managed root", async () => {
		const tmp = tempDir("omp-wr-outside-");
		const root = join(tmp, "workspaces");
		mkdirSync(root, { recursive: true });
		const outside = join(tmp, "outside-volume");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "keep.txt"), "keep\n");

		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"d1",
				makeEntry({ daemonId: "d1", cwd: outside, workspace: bwrapWorkspace() }),
			),
		).rejects.toThrow();
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});

	test("deleting one workspace's volume preserves the root, the state dirs, and siblings", async () => {
		const root = join(tempDir("omp-wr-siblings-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const a = join(root, "d1");
		const b = join(root, "d2");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		writeFileSync(join(a, "a.txt"), "a\n");
		writeFileSync(join(b, "b.txt"), "b\n");
		const stateDir = join(root, ".kubernetes", "4".repeat(32));
		mkdirSync(stateDir, { recursive: true });

		await createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
			"d1",
			makeEntry({ daemonId: "d1", cwd: a, workspace: bwrapWorkspace() }),
		);

		expect(existsSync(a)).toBe(false);
		expect(existsSync(join(b, "b.txt"))).toBe(true);
		expect(existsSync(stateDir)).toBe(true);
		expect(existsSync(root)).toBe(true);
	});

	test("the local-volume path refuses the managed root itself", async () => {
		const root = join(tempDir("omp-wr-root-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const sibling = join(root, "d2");
		mkdirSync(sibling, { recursive: true });

		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				basename(root),
				makeEntry({ daemonId: basename(root), cwd: root, workspace: bwrapWorkspace() }),
			),
		).rejects.toThrow();
		expect(existsSync(root)).toBe(true);
		expect(existsSync(sibling)).toBe(true);
	});

	test("the kubernetes path refuses an escaping identity and preserves everything", async () => {
		const root = join(tempDir("omp-wr-escape-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const stateRoot = join(root, ".kubernetes");
		mkdirSync(stateRoot, { recursive: true });
		const sibling = join(stateRoot, "5".repeat(32));
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "keep.json"), "{}\n");
		const volume = join(root, "d1");
		mkdirSync(volume, { recursive: true });

		// `..` is not a 32-hex resource identity: it would resolve to the
		// shared state root (and delete every sibling) if interpolated.
		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"d1",
				makeEntry({ daemonId: "d1", cwd: volume, workspace: kubernetesWorkspace("..") }),
			),
		).rejects.toThrow();
		expect(existsSync(stateRoot)).toBe(true);
		expect(existsSync(join(sibling, "keep.json"))).toBe(true);
		expect(existsSync(volume)).toBe(true);
		expect(existsSync(root)).toBe(true);
	});

	test("the kubernetes path refuses a state path redirected by a symlink", async () => {
		const tmp = tempDir("omp-wr-symlink-");
		const root = join(tmp, "workspaces");
		mkdirSync(root, { recursive: true });
		const outside = join(tmp, "outside-state");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "keep.txt"), "keep\n");
		const identity = "6".repeat(32);
		const stateRoot = join(root, ".kubernetes");
		mkdirSync(stateRoot, { recursive: true });
		symlinkSync(outside, join(stateRoot, identity), "dir");

		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"d1",
				makeEntry({ daemonId: "d1", workspace: kubernetesWorkspace(identity) }),
			),
		).rejects.toThrow();
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});

	test("the kubernetes path refuses a state candidate symlinked to a sibling identity", async () => {
		const root = join(tempDir("omp-wr-sibling-link-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const stateRoot = join(root, ".kubernetes");
		mkdirSync(stateRoot, { recursive: true });
		const identity = "7".repeat(32);
		const siblingIdentity = "8".repeat(32);
		const sibling = join(stateRoot, siblingIdentity);
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "keep.json"), "{}\n");
		// A corrupted symlink at the record's own identity points at a sibling
		// identity INSIDE the same state root: strict containment alone would
		// follow it and delete the sibling.
		symlinkSync(sibling, join(stateRoot, identity), "dir");

		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"d1",
				makeEntry({ daemonId: "d1", workspace: kubernetesWorkspace(identity) }),
			),
		).rejects.toThrow();
		expect(existsSync(join(sibling, "keep.json"))).toBe(true);
	});

	test("the kubernetes path refuses a symlinked .kubernetes parent even inside the root", async () => {
		const root = join(tempDir("omp-wr-parent-link-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const identity = "9".repeat(32);
		const realState = join(root, "real-state");
		mkdirSync(join(realState, identity), { recursive: true });
		writeFileSync(join(realState, identity, "keep.json"), "{}\n");
		symlinkSync(realState, join(root, ".kubernetes"), "dir");

		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"d1",
				makeEntry({ daemonId: "d1", workspace: kubernetesWorkspace(identity) }),
			),
		).rejects.toThrow();
		expect(existsSync(join(realState, identity, "keep.json"))).toBe(true);
	});

	test("the local-volume path refuses a volume symlinked to a sibling workspace", async () => {
		const root = join(tempDir("omp-wr-volume-link-"), "workspaces");
		mkdirSync(root, { recursive: true });
		const sibling = join(root, "d2");
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "keep.txt"), "keep\n");
		symlinkSync(sibling, join(root, "d1"), "dir");

		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"d1",
				makeEntry({ daemonId: "d1", cwd: join(root, "d1"), workspace: bwrapWorkspace() }),
			),
		).rejects.toThrow();
		expect(existsSync(join(sibling, "keep.txt"))).toBe(true);
	});

	test("a non-segment workspace id is refused and preserves the root and its parent", async () => {
		const tmp = tempDir("omp-wr-badid-");
		const root = join(tmp, "workspaces");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "root-keep.txt"), "keep\n");
		writeFileSync(join(tmp, "parent-keep.txt"), "keep\n");

		// Kubernetes lane: an unvalidated `..` id would normalize the legacy
		// state candidate onto the workspace root itself.
		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"..",
				makeEntry({ daemonId: "..", workspace: kubernetesWorkspace("a".repeat(32)) }),
			),
		).rejects.toThrow();
		// Local-volume lane: an unvalidated `..` id would normalize the
		// candidate onto the root's PARENT (tmp) and delete it.
		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"..",
				makeEntry({ daemonId: "..", cwd: tmp, workspace: bwrapWorkspace() }),
			),
		).rejects.toThrow();
		// A slashed id could escape the dedicated parent outright.
		await expect(
			createWorkspaceResourceDeleter(root).deleteWorkspaceResources(
				"../escape",
				makeEntry({ daemonId: "../escape", cwd: tmp, workspace: bwrapWorkspace() }),
			),
		).rejects.toThrow();

		expect(existsSync(root)).toBe(true);
		expect(existsSync(join(root, "root-keep.txt"))).toBe(true);
		expect(existsSync(join(tmp, "parent-keep.txt"))).toBe(true);
	});
});
