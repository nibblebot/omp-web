import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cleanupTempDirs } from "../shared/testkit";
import {
	applyUpdate,
	compareVersions,
	main,
	parseManifest,
	resolveBase,
	sha256Of,
	UpdateError,
} from "./update";

afterAll(cleanupTempDirs);

/** A fake install seam: records every tarball path handed to it. */
function fakeInstall(code = 0) {
	const installs: string[] = [];
	const install = async (tarballPath: string) => {
		installs.push(tarballPath);
		return code;
	};
	return { installs, install };
}

/**
 * Local manifest/tarball fixture on an ephemeral port. The handler returns
 * undefined for unmatched paths → the server answers 404, so routes the
 * pipeline must NOT touch can be proven by omission.
 */
async function serveFixture(handler: (req: Request) => Response | undefined) {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			return handler(req) ?? new Response("not found", { status: 404 });
		},
	});
	return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Arbitrary tarball bytes with a sha256 computed independently of sha256Of. */
function tarballFixture() {
	const bytes = new TextEncoder().encode("fake tarball payload for omp-web update tests");
	return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

/** Serve a v0.2.0 manifest + tarball (or a pinned base variant). */
async function serveUpdate() {
	const { bytes, sha } = tarballFixture();
	const fixture = await serveFixture((req) => {
		const path = new URL(req.url).pathname;
		if (path === "/release-manifest.json") {
			return Response.json({
				version: "0.2.0",
				tarball: "omp-web-0.2.0.tgz",
				sha256: sha,
				extraKey: "tolerated",
			});
		}
		if (path === "/omp-web-0.2.0.tgz") return new Response(bytes);
		return undefined;
	});
	return { ...fixture, sha };
}

/** Await a rejection and return it as an UpdateError, failing otherwise. */
async function rejection(p: Promise<unknown>): Promise<UpdateError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(UpdateError);
		return e as UpdateError;
	}
	throw new Error("expected the promise to reject");
}

describe("parseManifest", () => {
	test("accepts a valid manifest and tolerates extra keys", () => {
		const manifest = parseManifest({
			version: "0.2.0",
			tarball: "omp-web-0.2.0.tgz",
			sha256: "ab".repeat(32),
			extra: 1,
		});
		expect(manifest).toEqual({
			version: "0.2.0",
			tarball: "omp-web-0.2.0.tgz",
			sha256: "ab".repeat(32),
		});
	});

	test("rejects missing, wrong-typed, or non-object manifests", () => {
		expect(() => parseManifest({ tarball: "x.tgz", sha256: "ab" })).toThrow(/version/);
		expect(() => parseManifest({ version: "", tarball: "x.tgz", sha256: "ab" })).toThrow(/version/);
		expect(() => parseManifest({ version: "0.2.0", tarball: 5, sha256: "ab" })).toThrow(/tarball/);
		expect(() => parseManifest({ version: "0.2.0", tarball: "x.tgz", sha256: null })).toThrow(
			/sha256/,
		);
		expect(() => parseManifest(null)).toThrow(/object/);
		expect(() => parseManifest(["0.2.0"])).toThrow(/object/);
		expect(() => parseManifest("0.2.0")).toThrow(/object/);
	});
});

describe("compareVersions", () => {
	test("orders numeric dot-split versions", () => {
		expect(compareVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
		expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
	});

	test("sorts dev below any release", () => {
		expect(compareVersions("0.1.0", "dev")).toBeGreaterThan(0);
		expect(compareVersions("dev", "0.1.0")).toBeLessThan(0);
		expect(compareVersions("dev", "dev")).toBe(0);
	});
});

describe("resolveBase", () => {
	test("strips a trailing slash and leaves an unpinned base alone", () => {
		expect(resolveBase("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
	});

	test("pin rewrites a latest/download suffix to the per-release path", () => {
		expect(resolveBase("https://github.com/o/r/releases/latest/download", "0.2.0")).toBe(
			"https://github.com/o/r/releases/download/v0.2.0",
		);
		expect(resolveBase("https://github.com/o/r/releases/latest/download/", "0.2.0")).toBe(
			"https://github.com/o/r/releases/download/v0.2.0",
		);
	});

	test("pin appends /download/v<x.y.z> to any other base", () => {
		expect(resolveBase("http://127.0.0.1:8000", "0.2.0")).toBe(
			"http://127.0.0.1:8000/download/v0.2.0",
		);
		expect(resolveBase("http://127.0.0.1:8000/base/", "0.2.0")).toBe(
			"http://127.0.0.1:8000/base/download/v0.2.0",
		);
	});
});

describe("sha256Of", () => {
	test("matches the well-known sha256 of 'abc'", () => {
		expect(sha256Of(new TextEncoder().encode("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("applyUpdate", () => {
	test("happy path verifies sha256 and installs the verified tarball", async () => {
		const { base, stop, sha } = await serveUpdate();
		const { installs, install } = fakeInstall();
		try {
			const result = await applyUpdate(
				base,
				{ current: "0.1.0", force: false },
				{ fetch, install },
			);
			expect(result).toEqual({ installedVersion: "0.2.0", installCalled: true });
			expect(installs).toHaveLength(1);
			expect(installs[0]).toMatch(/omp-web-update-[0-9a-z]+\.tgz$/);
			expect(installs[0]).not.toContain(base);
			expect(sha).toHaveLength(64);
			// The temp tarball is deleted on every exit path.
			expect(await Bun.file(installs[0]).exists()).toBe(false);
		} finally {
			await stop();
		}
	});

	test("sha256 mismatch throws and never calls install", async () => {
		const { bytes } = tarballFixture();
		const { base, stop } = await serveFixture((req) => {
			const path = new URL(req.url).pathname;
			if (path === "/release-manifest.json") {
				return Response.json({
					version: "0.2.0",
					tarball: "omp-web-0.2.0.tgz",
					sha256: "0".repeat(64),
				});
			}
			if (path === "/omp-web-0.2.0.tgz") return new Response(bytes);
			return undefined;
		});
		const { installs, install } = fakeInstall();
		try {
			const e = await rejection(
				applyUpdate(base, { current: "0.1.0", force: false }, { fetch, install }),
			);
			expect(e.code).toBe("sha");
			expect(e.message).toContain("sha256 mismatch");
			expect(installs).toHaveLength(0);
		} finally {
			await stop();
		}
	});

	test("manifest 404 surfaces a fetch error", async () => {
		const { base, stop } = await serveFixture(() => undefined);
		const { installs, install } = fakeInstall();
		try {
			const e = await rejection(
				applyUpdate(base, { current: "0.1.0", force: false }, { fetch, install }),
			);
			expect(e.code).toBe("fetch");
			expect(e.message).toContain("404");
			expect(installs).toHaveLength(0);
		} finally {
			await stop();
		}
	});

	test("a manifest not newer than current is up to date and installs nothing", async () => {
		const { sha } = tarballFixture();
		const { base, stop } = await serveFixture((req) => {
			if (new URL(req.url).pathname === "/release-manifest.json") {
				return Response.json({ version: "0.1.0", tarball: "omp-web-0.1.0.tgz", sha256: sha });
			}
			return undefined;
		});
		const { installs, install } = fakeInstall();
		try {
			const e = await rejection(
				applyUpdate(base, { current: "0.2.0", force: false }, { fetch, install }),
			);
			expect(e.code).toBe("up-to-date");
			expect(e.message).toBe("omp-web is up to date (0.2.0)");
			expect(installs).toHaveLength(0);
		} finally {
			await stop();
		}
	});

	test("check mode compares without downloading or installing", async () => {
		const { sha } = tarballFixture();
		// No tarball route: a download attempt would 404 and fail the test.
		const { base, stop } = await serveFixture((req) => {
			if (new URL(req.url).pathname === "/release-manifest.json") {
				return Response.json({ version: "0.2.0", tarball: "omp-web-0.2.0.tgz", sha256: sha });
			}
			return undefined;
		});
		const { installs, install } = fakeInstall();
		try {
			const result = await applyUpdate(
				base,
				{ current: "0.1.0", force: false, check: true },
				{ fetch, install },
			);
			expect(result).toEqual({ installedVersion: "0.2.0", installCalled: false });
			expect(installs).toHaveLength(0);
		} finally {
			await stop();
		}
	});

	test("dev current without force is refused", async () => {
		const { base, stop } = await serveFixture(() => undefined);
		const { installs, install } = fakeInstall();
		try {
			const e = await rejection(
				applyUpdate(base, { current: "dev", force: false }, { fetch, install }),
			);
			expect(e.code).toBe("dev");
			expect(installs).toHaveLength(0);
		} finally {
			await stop();
		}
	});

	test("dev current with force proceeds to install", async () => {
		const { base, stop } = await serveUpdate();
		const { installs, install } = fakeInstall();
		try {
			const result = await applyUpdate(base, { current: "dev", force: true }, { fetch, install });
			expect(result.installedVersion).toBe("0.2.0");
			expect(installs).toHaveLength(1);
		} finally {
			await stop();
		}
	});

	test("a nonzero install exit throws and still cleans up the temp file", async () => {
		const { base, stop } = await serveUpdate();
		const { installs, install } = fakeInstall(7);
		try {
			const e = await rejection(
				applyUpdate(base, { current: "0.1.0", force: false }, { fetch, install }),
			);
			expect(e.code).toBe("install");
			expect(e.message).toContain("exit 7");
			expect(await Bun.file(installs[0]).exists()).toBe(false);
		} finally {
			await stop();
		}
	});
});

describe("main", () => {
	const CHANNEL = "OMP_WEB_UPDATE_URL";

	function withEnv<T>(url: string | undefined, fn: () => Promise<T>): Promise<T> {
		const prev = process.env[CHANNEL];
		if (url === undefined) delete process.env[CHANNEL];
		else process.env[CHANNEL] = url;
		return fn().finally(() => {
			if (prev === undefined) delete process.env[CHANNEL];
			else process.env[CHANNEL] = prev;
		});
	}

	function captureConsole() {
		const out: string[] = [];
		const err: string[] = [];
		const origOut = console.log;
		const origErr = console.error;
		console.log = (...args: unknown[]) => {
			out.push(args.map(String).join(" "));
		};
		console.error = (...args: unknown[]) => {
			err.push(args.map(String).join(" "));
		};
		return {
			out,
			err,
			restore: () => {
				console.log = origOut;
				console.error = origErr;
			},
		};
	}

	test("with no channel configured, prints the env hint to stderr and exits 1", async () => {
		const c = captureConsole();
		try {
			const code = await withEnv(undefined, () => main(["--check"]));
			expect(code).toBe(1);
			expect(c.err.join("\n")).toContain("no update channel configured (set OMP_WEB_UPDATE_URL)");
			expect(c.out).toHaveLength(0);
		} finally {
			c.restore();
		}
	});

	test("--check prints the manifest version and exits 0", async () => {
		const { base, stop } = await serveUpdate();
		const c = captureConsole();
		try {
			const code = await withEnv(base, () => main(["--check"]));
			expect(code).toBe(0);
			expect(c.out).toEqual(["0.2.0"]);
			expect(c.err).toHaveLength(0);
		} finally {
			c.restore();
			await stop();
		}
	});

	test("--check reports up to date when the manifest is not newer", async () => {
		const { sha } = tarballFixture();
		const { base, stop } = await serveFixture((req) => {
			if (new URL(req.url).pathname === "/release-manifest.json") {
				return Response.json({ version: "0.1.0", tarball: "omp-web-0.1.0.tgz", sha256: sha });
			}
			return undefined;
		});
		const c = captureConsole();
		try {
			// resolveVersion() reads package.json → 0.1.0, equal to the manifest.
			const code = await withEnv(base, () => main(["--check"]));
			expect(code).toBe(0);
			expect(c.out).toEqual(["omp-web is up to date (0.1.0)"]);
		} finally {
			c.restore();
			await stop();
		}
	});

	test("--check --version pins the per-release base", async () => {
		const { sha } = tarballFixture();
		const { base, stop } = await serveFixture((req) => {
			if (new URL(req.url).pathname === "/download/v0.2.0/release-manifest.json") {
				return Response.json({ version: "0.2.0", tarball: "omp-web-0.2.0.tgz", sha256: sha });
			}
			return undefined;
		});
		const c = captureConsole();
		try {
			const code = await withEnv(base, () => main(["--check", "--version", "0.2.0"]));
			expect(code).toBe(0);
			expect(c.out).toEqual(["0.2.0"]);
		} finally {
			c.restore();
			await stop();
		}
	});

	test("unknown flags and a missing --version value exit 1", async () => {
		const c = captureConsole();
		try {
			await expect(withEnv(undefined, () => main(["--bogus"]))).resolves.toBe(1);
			expect(c.err.join("\n")).toContain("unknown update flag");
			await expect(withEnv(undefined, () => main(["--version"]))).resolves.toBe(1);
			expect(c.err.join("\n")).toContain("--version requires a version argument");
		} finally {
			c.restore();
		}
	});
});
