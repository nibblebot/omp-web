import { join } from "node:path";

/** Provider key written into `models.yml`. */
export const PROFILE_PROVIDER = "profilefake";
/** Model id served by the fake server. */
export const PROFILE_MODEL_ID = "profile-1";
/** `provider/model` string every session role resolves to. */
export const PROFILE_MODEL = `${PROFILE_PROVIDER}/${PROFILE_MODEL_ID}`;

/**
 * Settings roles pinned to the fake model. Every role the SDK can route a side
 * request through (titles, subagents, summaries) is listed so no role falls back
 * to a bundled provider that would need credentials.
 */
const MODEL_ROLES = [
	"default",
	"task",
	"smol",
	"slow",
	"plan",
	"commit",
	"advisor",
	"judge",
] as const;

/**
 * Write the agent directory a profiling session runs against
 * (`PI_CODING_AGENT_DIR=<dir>`): `models.yml` declares the fake OpenAI-compatible
 * provider (`auth: none`, so no credential or borrowed login is needed) and
 * `config.yml` makes it the default model for every role with tool approvals set
 * to `yolo` so real `bash` calls never block on a prompt.
 */
export async function writeAgentDir(dir: string, fakeUrl: string): Promise<void> {
	const baseUrl = `${fakeUrl.replace(/\/+$/, "")}/v1`;
	const models = [
		"providers:",
		`  ${PROFILE_PROVIDER}:`,
		`    baseUrl: ${baseUrl}`,
		"    api: openai-completions",
		"    auth: none",
		"    models:",
		`      - id: ${PROFILE_MODEL_ID}`,
		"        name: Profile Fake Model",
		"        reasoning: false",
		"        input: [text]",
		"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
		"        contextWindow: 100000000",
		"        maxTokens: 64000",
		"",
	].join("\n");
	const roles = MODEL_ROLES.map((role) => `  ${role}: ${PROFILE_MODEL}`).join("\n");
	const config = [
		"modelRoles:",
		roles,
		"tools:",
		"  approvalMode: yolo",
		"compaction:",
		"  enabled: false",
		"",
	].join("\n");
	await Bun.write(join(dir, "models.yml"), models);
	await Bun.write(join(dir, "config.yml"), config);
}
