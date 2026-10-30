import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { FEATURES_KEY } from "../features/manifest";
import { featurePreload } from "../build/feature-preload";
import { fontPreload } from "../build/font-preload";
import { precompress } from "../build/precompress";

afterAll(cleanupTempDirs);

// A real vite build over fixture feature entries named after real feature ids:
// plugins and debug default to on, analysis is in development (manifest.ts).
const FILLER = "// filler line that compresses very well\n".repeat(80);
const FIXTURE: Record<string, string> = {
	"index.html":
		'<!doctype html><html><head></head><body><script type="module" src="/main.ts"></script></body></html>\n',
	"main.ts": [
		'console.info("CORE_ENTRY_MARK");',
		'void import("./features/plugins");',
		'void import("./features/debug");',
		'void import("./features/analysis");',
		FILLER,
	].join("\n"),
	"features/plugins.ts": `import "./plugins.css";\nconsole.info("PLUGINS_MARK");\n${FILLER}`,
	"features/plugins.css": `.PLUGINS_CSS_MARK { color: red; }\n${Array.from({ length: 100 }, (_, n) => `.rule-${n} { margin: ${n}px; padding: ${n}px; }`).join("\n")}\n`,
	"features/debug.ts": 'console.info("DEBUG_MARK");\n',
	"features/analysis.ts": 'console.info("ANALYSIS_MARK");\n',
	"tiny.txt": "tiny\n",
};

describe("build plugins (real vite build)", () => {
	const root = realpathSync(tempDir("build-plugins-"));
	const outDir = join(root, "dist");
	let html: string;

	/** The emitted asset under assets/ whose content contains `marker`. */
	function assetWith(marker: string): string {
		const hits = readdirSync(join(outDir, "assets")).filter(
			(file) =>
				!/\.(br|gz)$/.test(file) &&
				readFileSync(join(outDir, "assets", file), "utf8").includes(marker),
		);
		expect(hits).toHaveLength(1);
		return hits[0]!;
	}

	beforeAll(async () => {
		for (const [path, source] of Object.entries(FIXTURE)) {
			const abs = join(root, path);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, source);
		}
		mkdirSync(join(root, "public"), { recursive: true });
		writeFileSync(join(root, "public", "tiny.txt"), "tiny\n");
		await build({
			root,
			configFile: false,
			logLevel: "silent",
			plugins: [featurePreload({ featuresDir: join(root, "features") }), precompress()],
			build: { outDir, emptyOutDir: true },
		});
		html = readFileSync(join(outDir, "index.html"), "utf8");
	}, 60_000);

	describe("precompress", () => {
		test("writes Brotli and gzip siblings that decode to the original", () => {
			const entry = assetWith("CORE_ENTRY_MARK");
			const original = readFileSync(join(outDir, "assets", entry));
			const br = readFileSync(join(outDir, "assets", `${entry}.br`));
			const gz = readFileSync(join(outDir, "assets", `${entry}.gz`));
			expect(br.byteLength).toBeLessThan(original.byteLength / 2);
			expect(Buffer.from(brotliDecompressSync(br)).equals(original)).toBe(true);
			expect(Buffer.from(gunzipSync(gz)).equals(original)).toBe(true);
			const css = join(outDir, "assets", assetWith("PLUGINS_CSS_MARK"));
			expect(existsSync(`${css}.br`)).toBe(true);
			expect(existsSync(`${css}.gz`)).toBe(true);
		});

		test("skips files under 1 KiB", () => {
			expect(existsSync(join(outDir, "tiny.txt"))).toBe(true);
			expect(existsSync(join(outDir, "tiny.txt.br"))).toBe(false);
			expect(existsSync(join(outDir, "tiny.txt.gz"))).toBe(false);
			expect(existsSync(join(outDir, "assets", `${assetWith("DEBUG_MARK")}.br`))).toBe(false);
		});
	});

	describe("featurePreload", () => {
		/** Run the hint script against stored choices; returns the links it adds as `rel href`. */
		function hintsFor(stored: string | null): string[] {
			const script = /<script>(\(function\(\)\{var c=.*?)<\/script>/s.exec(html)?.[1];
			expect(script).toBeDefined();
			const links: Array<{ rel?: string; href?: string; crossOrigin?: string; as?: string }> = [];
			const document = {
				createElement: () => ({}) as (typeof links)[number],
				head: { appendChild: (link: (typeof links)[number]) => links.push(link) },
			};
			const localStorage = {
				getItem: (key: string) => (key === FEATURES_KEY ? stored : null),
			};
			new Function("document", "localStorage", script!)(document, localStorage);
			return links.map((l) => `${l.rel} ${l.href}`);
		}

		test("hints the chunks of default-on features, and only those", () => {
			const hints = hintsFor(null);
			expect(hints).toContain(`modulepreload /assets/${assetWith("PLUGINS_MARK")}`);
			expect(hints).toContain(`preload /assets/${assetWith("PLUGINS_CSS_MARK")}`);
			expect(hints).toContain(`modulepreload /assets/${assetWith("DEBUG_MARK")}`);
			// Analysis is in development: never hinted.
			expect(hints.join("\n")).not.toContain(assetWith("ANALYSIS_MARK"));
			// The entry is the page's own script, not a hint.
			expect(hints.join("\n")).not.toContain(assetWith("CORE_ENTRY_MARK"));
		});

		test("skips a feature this browser turned off", () => {
			const hints = hintsFor(JSON.stringify({ plugins: false })).join("\n");
			expect(hints).not.toContain(assetWith("PLUGINS_MARK"));
			expect(hints).not.toContain(assetWith("PLUGINS_CSS_MARK"));
			expect(hints).toContain(assetWith("DEBUG_MARK"));
		});

		test("survives unreadable or malformed storage", () => {
			expect(hintsFor("not json")).toHaveLength(3);
		});
	});
});

describe("fontPreload (real vite build)", () => {
	// Above vite's 4 KiB asset inline limit, so the font is emitted, not a data URL.
	const FONT = Buffer.alloc(8192, 7);

	async function buildWith(files: string[]): Promise<string> {
		const root = realpathSync(tempDir("font-preload-"));
		mkdirSync(join(root, "files"), { recursive: true });
		writeFileSync(join(root, "files", "demo-latin-wght-normal.woff2"), FONT);
		writeFileSync(
			join(root, "index.html"),
			'<!doctype html><html><head></head><body><script type="module" src="/main.ts"></script></body></html>\n',
		);
		writeFileSync(join(root, "main.ts"), 'import "./fonts.css";\n');
		writeFileSync(
			join(root, "fonts.css"),
			"@font-face { font-family: Demo; src: url(./files/demo-latin-wght-normal.woff2) format('woff2'); }\n",
		);
		const outDir = join(root, "dist");
		await build({
			root,
			configFile: false,
			logLevel: "silent",
			plugins: [fontPreload({ files })],
			build: { outDir, emptyOutDir: true },
		});
		return readFileSync(join(outDir, "index.html"), "utf8");
	}

	test("links the hashed emitted font as a crossorigin font preload", async () => {
		const html = await buildWith(["demo-latin-wght-normal.woff2"]);
		const link =
			/<link rel="preload" as="font" type="font\/woff2" crossorigin="" href="(\/assets\/demo-latin-wght-normal-[^"]+\.woff2)">/.exec(
				html,
			);
		expect(link).not.toBeNull();
		expect(html).toContain(`href="${link![1]}"`);
	}, 60_000);

	test("fails the build when a listed font is not emitted", async () => {
		await expect(buildWith(["missing-latin-wght-normal.woff2"])).rejects.toThrow(
			"no emitted asset came from missing-latin-wght-normal.woff2",
		);
	}, 60_000);
});
