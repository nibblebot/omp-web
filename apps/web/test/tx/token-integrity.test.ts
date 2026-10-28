import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const txCss = readFileSync(join(import.meta.dir, "..", "..", "tx", "tx.css"), "utf8");

const TX_BANNER = "/* ── tx: transcripts view ── */";
const bannerAt = txCss.indexOf(TX_BANNER);
if (bannerAt === -1) throw new Error("tx section banner not found in apps/web/tx/tx.css");
const txSection = txCss.slice(bannerAt);

test("every var(--tx-...) reference inside the tx section is defined there", () => {
	const defined = new Set<string>();
	for (const m of txSection.matchAll(/(--tx-[\w-]+):/g)) defined.add(m[1]!);
	const refs = new Set<string>();
	for (const m of txSection.matchAll(/var\((--tx-[\w-]+)\)/g)) refs.add(m[1]!);
	expect(refs.size).toBeGreaterThan(10);
	for (const name of refs) expect(defined.has(name), `missing definition for ${name}`).toBe(true);
});
