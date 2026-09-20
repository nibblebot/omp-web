import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import { baseLinks } from "./src/base-links.mjs";

// GitHub Pages serves this site from the repository path, so the canonical
// origin is the user site and every internal URL lives under `base`. Astro
// prefixes the URLs it generates; `baseLinks` does the same for links authored
// in Markdown (see `src/base-links.mjs`).
const site = "https://nibblebot.github.io";
const base = "/omp-web/";

export default defineConfig({
	site,
	base,
	markdown: {
		// Astro's default processor is `satteri()`; passing our own keeps those
		// defaults and adds the base-prefix rewrite. Starlight registers its
		// own Markdown plugins on this same processor.
		processor: satteri({ hastPlugins: [baseLinks(base)] }),
	},
	integrations: [
		starlight({
			title: "omp-web",
			description: "Web sessions and fleet management for Oh My Pi.",
			editLink: {
				baseUrl: "https://github.com/nibblebot/omp-web/edit/docs/docs/",
			},
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/nibblebot/omp-web",
				},
			],
			sidebar: [
				{
					label: "Getting Started",
					items: [
						{ label: "What is omp-web?", slug: "getting-started/overview" },
						{ label: "Installation", slug: "getting-started/installation" },
						{ label: "First run", slug: "getting-started/first-run" },
						{ label: "Add your first project", slug: "getting-started/add-first-project" },
						{ label: "Start your first session", slug: "getting-started/start-first-session" },
						{ label: "Interface tour", slug: "getting-started/interface-tour" },
					],
				},
				{
					label: "Core Concepts",
					items: [
						{ label: "Fleet and single-session modes", slug: "concepts/runtime-modes" },
						{
							label: "Projects, worktrees, session daemons, and sessions",
							slug: "concepts/projects-worktrees-session-daemons-sessions",
						},
						{ label: "Session persistence", slug: "concepts/session-persistence" },
						{ label: "Session daemon lifecycle", slug: "concepts/session-daemon-lifecycle" },
						{ label: "Local and remote sessions", slug: "concepts/local-and-remote" },
					],
				},
				{
					label: "Working with Sessions",
					items: [
						{ label: "Prompting the agent", slug: "sessions/prompting" },
						{ label: "Steering, follow-ups, and queues", slug: "sessions/queues" },
						{ label: "Tool calls, diffs, and images", slug: "sessions/tools-diffs-images" },
						{ label: "Models, roles, and thinking levels", slug: "sessions/models-roles-thinking" },
						{ label: "Goals and plan mode", slug: "sessions/goals-and-plan" },
						{ label: "Manage session history", slug: "sessions/history" },
						{ label: "Compaction, retry, and recovery", slug: "sessions/recovery" },
						{ label: "Export and download sessions", slug: "sessions/export" },
					],
				},
				{
					label: "Fleet Management",
					items: [
						{ label: "The fleet sidebar", slug: "fleet/sidebar" },
						{ label: "Register and remove projects", slug: "fleet/projects" },
						{ label: "Create and adopt worktrees", slug: "fleet/worktrees" },
						{
							label: "Start, stop, wake, and remove session daemons",
							slug: "fleet/session-daemon-operations",
						},
						{ label: "Resume previous sessions", slug: "fleet/resume-sessions" },
						{ label: "Understand roster status", slug: "fleet/roster-status" },
						{ label: "Safely delete managed worktrees", slug: "fleet/delete-worktrees" },
					],
				},
				{
					label: "Analysis and Usage",
					items: [
						{ label: "Context, tokens, and cost", slug: "analysis/context-tokens-cost" },
						{ label: "Provider usage limits", slug: "analysis/provider-usage" },
						{ label: "Browse historical transcripts", slug: "analysis/transcripts" },
						{ label: "Session analytics", slug: "analysis/analytics" },
						{ label: "Subagent activity and transcripts", slug: "analysis/subagents" },
						{ label: "Sync the statistics database", slug: "analysis/stats-sync" },
					],
				},
				{
					label: "Configuration",
					items: [
						{ label: "Settings overview", slug: "configuration/settings" },
						{ label: "Models and provider authentication", slug: "configuration/models-and-auth" },
						{ label: "Web interface preferences", slug: "configuration/web-preferences" },
						{ label: "Data and state management", slug: "configuration/data-and-state" },
						{ label: "Configure spawn templates", slug: "configuration/spawn-templates" },
					],
				},
				{
					label: "CLI and Automation",
					items: [
						{ label: "CLI overview", slug: "cli/overview" },
						{ label: "Manage projects and worktrees", slug: "cli/projects-and-worktrees" },
						{ label: "Operate session daemons", slug: "cli/session-daemon-operations" },
						{ label: "Select multiple session daemons", slug: "cli/selectors" },
						{ label: "Fan-out prompting", slug: "cli/fanout" },
						{ label: "Run a standalone session daemon", slug: "cli/standalone" },
					],
				},
				{
					label: "Remote and Advanced",
					items: [
						{ label: "Run a remote session daemon over SSH", slug: "advanced/ssh" },
						{ label: "Run session daemons in Docker", slug: "advanced/docker" },
						{ label: "Integrate a custom provider", slug: "advanced/custom-provider" },
						{ label: "Collaboration rooms", slug: "advanced/collaboration" },
						{ label: "Single-session deployments", slug: "advanced/single-session-deployments" },
						{ label: "Architecture overview", slug: "advanced/architecture" },
					],
				},
				{
					label: "Operations",
					items: [
						{ label: "Networking and browser access", slug: "operations/networking" },
						{ label: "Security model", slug: "operations/security" },
						{ label: "Updates", slug: "operations/updates" },
						{ label: "Process lifecycle and recovery", slug: "operations/lifecycle-and-recovery" },
						{ label: "Debug panel and diagnostics", slug: "operations/diagnostics" },
						{ label: "Troubleshooting", slug: "operations/troubleshooting" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "Slash commands", slug: "reference/slash-commands" },
						{ label: "Keyboard shortcuts", slug: "reference/keyboard-shortcuts" },
						{ label: "CLI commands and flags", slug: "reference/cli" },
						{ label: "Configuration schema", slug: "reference/configuration" },
						{ label: "Environment variables", slug: "reference/environment" },
						{ label: "Files and directories", slug: "reference/files" },
						{ label: "Terminology", slug: "reference/terminology" },
					],
				},
				{
					label: "Project",
					items: [
						{ label: "Changelog", slug: "project/changelog" },
						{ label: "Contributing", slug: "project/contributing" },
						{ label: "Release process", slug: "project/release" },
						{ label: "Design", slug: "project/design" },
					],
				},
			],
		}),
	],
});
