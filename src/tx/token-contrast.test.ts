/**
 * Design-token regression test for the merged transcripts section.
 *
 * Reads the tx section of src/styles.css (from the tx banner comment to EOF)
 * and enforces:
 * - every `var(--tx-...)` referenced inside the section is defined there
 *   (the rename .badge→.tx-badge, --bg→--tx-bg, etc. must not leave dangles)
 * - the core semantic remaps point at the intended fleet tokens
 * - --tx-text-faint resolves to a WCAG AA 4.5:1 pair on both --tx-bg and
 *   --tx-bg-selected, in the default (dark) palette and in fleet's canonical
 *   light palette (fleet's light theme re-skins tx via the var() chains)
 * - dark-theme hierarchy: faint stays less prominent than dim
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");

const TX_BANNER = "/* ── tx: transcripts view ── */";
const bannerAt = css.indexOf(TX_BANNER);
if (bannerAt === -1) throw new Error("tx section banner not found in src/styles.css");
const txSection = css.slice(bannerAt);

/** Fleet palette block for a theme selector (default dark = `:root`). */
function parseFleetTokens(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`${selector} token block not found in src/styles.css`);
  const tokens: Record<string, string> = {};
  for (const m of block[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens[m[1]!] = m[2]!.trim();
  }
  return tokens;
}

/** All --tx-* definitions inside the tx section (light override wins). */
function parseTxTokens(): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const m of txSection.matchAll(/(--tx-[\w-]+):\s*([^;]+);/g)) {
    tokens[m[1]!] = m[2]!.trim();
  }
  return tokens;
}

const txTokens = parseTxTokens();
const dark = parseFleetTokens(":root");
const light = parseFleetTokens(':root[data-theme="light"]');

/** Resolve a token value through var() chains and srgb color-mix. */
function resolve(name: string, tx: Record<string, string>, fleet: Record<string, string>): string {
  const bare = name.replace(/^--/, "");
  const raw = tx[bare] ?? tx[`--${bare}`] ?? fleet[bare] ?? fleet[`--${bare}`];
  if (!raw) throw new Error(`no definition for --${bare}`);
  const varM = raw.match(/^var\(--([\w-]+)\)$/);
  if (varM) return resolve(varM[1]!, tx, fleet);
  const mixM = raw.match(/^color-mix\(in srgb,\s*var\(--([\w-]+)\)\s+([\d.]+)%,\s*var\(--([\w-]+)\)\s*\)$/);
  if (mixM) {
    const a = resolve(mixM[1]!, tx, fleet);
    const b = resolve(mixM[3]!, tx, fleet);
    return mixHex(a, b, parseFloat(mixM[2]!));
  }
  return raw;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a 6-digit hex color: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixHex(aHex: string, bHex: string, pctA: number): string {
  const [ar, ag, ab] = hexToRgb(aHex);
  const [br, bg, bb] = hexToRgb(bHex);
  const mix = (a: number, b: number) => Math.round(a * (pctA / 100) + b * (1 - pctA / 100));
  return `#${[mix(ar, br), mix(ag, bg), mix(ab, bb)].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("tx section token integrity", () => {
  test("every var(--tx-...) reference inside the section is defined there", () => {
    const refs = new Set<string>();
    for (const m of txSection.matchAll(/var\((--tx-[\w-]+)\)/g)) refs.add(m[1]!);
    expect(refs.size).toBeGreaterThan(10);
    for (const name of refs) {
      expect(txTokens[name], `missing definition for ${name}`).toBeDefined();
    }
  });

  test("core tokens remap onto the intended fleet tokens", () => {
    expect(txTokens["--tx-bg"]).toBe("var(--bg)");
    expect(txTokens["--tx-text"]).toBe("var(--text)");
    expect(txTokens["--tx-accent"]).toBe("var(--accent)");
    expect(txTokens["--tx-accent-dim"]).toBe("var(--accent-dim)");
    expect(txTokens["--tx-border"]).toBe("var(--border)");
    expect(txTokens["--tx-text-dim"]).toBe("var(--muted)");
    expect(txTokens["--tx-text-faint"]).toBe("var(--muted-2)");
    expect(txTokens["--tx-err"]).toBe("var(--error)");
    expect(txTokens["--tx-warn"]).toBe("var(--warning)");
    expect(txTokens["--tx-ok"]).toBe("var(--success)");
  });

  test("font stacks stay literal tx fonts", () => {
    expect(txTokens["--tx-mono"]).toMatch(/^"Noto Sans Mono", ui-monospace/);
    expect(txTokens["--tx-sans"]).toMatch(/^"Noto Sans", system-ui/);
  });

  test("light override block covers every fleet light theme selector", () => {
    const lightBlock = txSection.slice(txSection.indexOf("Light palettes"));
    const block = lightBlock.slice(0, lightBlock.indexOf("}") + 1);
    expect(block).toContain(':root[data-theme="light"]');
    expect(block).toContain(':root[data-theme="catppuccin-latte"]');
    expect(block).toContain(':root[data-theme="omp-light"]');
    expect(block).toContain("--tx-banner-code-bg: rgba(255, 255, 255, 0.35)");
  });
});

describe("resolved tx contrast", () => {
  const faint = (fleet: Record<string, string>) => resolve("tx-text-faint", txTokens, fleet);
  const bg = (fleet: Record<string, string>) => resolve("tx-bg", txTokens, fleet);
  const bgSelected = (fleet: Record<string, string>) => resolve("tx-bg-selected", txTokens, fleet);
  const dim = (fleet: Record<string, string>) => resolve("tx-text-dim", txTokens, fleet);

  for (const [name, fleet] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    describe(name, () => {
      test("--tx-text-faint resolves to a 6-digit hex color", () => {
        const f = faint(fleet);
        expect(f).toMatch(/^#[0-9a-fA-F]{6}$/);
      });

      test("--tx-text-faint reaches 4.5:1 on the main background", () => {
        expect(contrast(faint(fleet), bg(fleet))).toBeGreaterThanOrEqual(4.5);
      });

      test("--tx-text-faint reaches 4.5:1 on the selected-row background", () => {
        expect(contrast(faint(fleet), bgSelected(fleet))).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  test("dark theme: faint stays less prominent than dim", () => {
    // On a dark background less prominent = darker.
    const onDarkBg = luminance(bg(dark)) < 0.5;
    expect(onDarkBg).toBe(true);
    expect(luminance(faint(dark))).toBeLessThan(luminance(dim(dark)));
  });
});
