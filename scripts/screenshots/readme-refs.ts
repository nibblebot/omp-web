/**
 * The README image guard: every `docs/screenshots/<file>` the README names must
 * be a file the screenshot script produces and must exist on disk. Browser-free;
 * `scripts/test/readme-screenshots.test.ts` runs it against the real README.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { outputFiles } from "./scenes";

/** `docs/screenshots/<name>` anywhere in the text: `src`, `srcset`, markdown links, absolute URLs. */
const REF = /docs\/screenshots\/([^\s"'()<>#?]+)/g;

/** The distinct file names the text references under `docs/screenshots/`, in order of appearance. */
export function screenshotRefs(text: string): string[] {
	return [...new Set([...text.matchAll(REF)].map((match) => match[1]!))];
}

/** One line per problem; empty when the README's images are all produced and present. */
export function checkReadmeImages(readme: string, screenshotsDir: string): string[] {
	const produced = new Set(outputFiles());
	const problems: string[] = [];
	for (const name of screenshotRefs(readme)) {
		if (!produced.has(name)) {
			problems.push(
				`README references docs/screenshots/${name}, which scripts/screenshots/scenes.ts does not produce`,
			);
		} else if (!existsSync(join(screenshotsDir, name))) {
			problems.push(
				`README references docs/screenshots/${name}, which is not on disk (run bun run screenshots --write)`,
			);
		}
	}
	return problems;
}
