import { describe, expect, test } from "bun:test";
import {
	FEATURE_BY_ID,
	FEATURE_IDS,
	FEATURES,
	featureForCommand,
	featuresForModal,
	type FeatureId,
	type FeatureInfo,
} from "../../features/manifest";
import { LOADERS } from "../../features/registry";
import type { ModalName } from "../../state";

/**
 * `FEATURES` is the only feature metadata the entry chunk carries: the
 * registry, the settings panel, and the command router all address features by
 * these ids and names. A duplicated id, a name claimed twice, or a declaration
 * that resolves to another feature would misroute a command or mount the wrong
 * modal's owner, so the table's consistency is asserted here instead of echoed
 * per feature.
 */

/** Feature ids declaring each name, in manifest order; a name declared twice by
 *  one feature shows up as that id twice. */
function claimedBy(
	declared: (feature: FeatureInfo) => readonly string[],
): Array<[string, string[]]> {
	const claims = new Map<string, string[]>();
	for (const feature of FEATURES) {
		for (const name of declared(feature)) {
			claims.set(name, [...(claims.get(name) ?? []), feature.id]);
		}
	}
	return [...claims];
}

describe("FEATURES manifest", () => {
	test("feature ids are unique and indexed consistently", () => {
		const ids = FEATURES.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(FEATURE_IDS).toEqual(ids);
		for (const feature of FEATURES) expect(FEATURE_BY_ID[feature.id]).toBe(feature);
	});

	test("every declared command and modal resolves back to its declaring feature", () => {
		for (const feature of FEATURES) {
			for (const name of feature.commands) {
				expect(featureForCommand(name)?.id).toBe(feature.id);
			}
			for (const name of feature.modals) {
				expect(featuresForModal(name).map((f) => f.id)).toContain(feature.id);
			}
		}
	});

	test("no command name is claimed by two features", () => {
		expect(claimedBy((f) => f.commands).filter(([, ids]) => ids.length > 1)).toEqual([]);
	});

	test("a modal shared by several features lists each owner once", () => {
		const shared = claimedBy((f) => f.modals).filter(([, ids]) => ids.length > 1);
		for (const [name, ids] of shared) {
			expect(new Set(ids).size).toBe(ids.length);
			expect(featuresForModal(name as ModalName).map((f) => f.id)).toEqual(ids as FeatureId[]);
		}
		expect(featuresForModal("integrations").map((f) => f.id)).toEqual(["integrations", "plugins"]);
	});

	test("core modals have no owning feature", () => {
		expect(featuresForModal("help")).toEqual([]);
	});

	test("every modal a feature module exports is declared in its manifest entry", async () => {
		for (const feature of FEATURES) {
			const { default: mod } = await LOADERS[feature.id]();
			const declared: readonly string[] = feature.modals;
			const undeclared = Object.keys(mod.modals ?? {}).filter((name) => !declared.includes(name));
			expect({ feature: feature.id, undeclared }).toEqual({ feature: feature.id, undeclared: [] });
		}
	});
});
