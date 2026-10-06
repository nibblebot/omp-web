## Unreleased

omp-web reconciles the single-session browser UX: equivalent browser capability through existing SDK/fleet/transport reuse. Wire stays OMP_PROTO 2 additive-only.

### Features
- Lifecycle: same-session clear, new identity, provider-state fresh, and session-ID-confirmed durable delete with fleet purge acknowledgment; misleading `/drop` alias removed (`/delete` + menu action replace it).
- Settings: effective value, owning layer, explicit presence, unset eligibility, SDK warnings, and live/next-session/restart effects on every row; typed record/list editing; project layer read-only with config-file guidance.
- Session graph: searchable ID-anchored tree with same-file navigate vs new-file branch, ask re-answer transaction, and entry-ID branch-from-card (no text-equality lookup).
- Editor: partitioned drafts with cleared-ring recovery, bounded Vim subset, large-paste folding, file attach validation, and download/export external-edit round-trip.
- Models: temporary session-only switch with effort-clamp feedback, preset list/save/apply/delete, and branch-local model-worker chips.
- Review: daemon-bound Git stage/unstage/hunk/commit with fingerprint gates; versioned plan approval with stale refusal; durable anchored annotations with drift/orphan marking; canonical phased todos with revision conflicts.
- Workers: searchable hub with live focus/steer, park/revive/resume lifecycle, advisor config/status/transcript, and guided goals/loops plus Vibe director controls.
- Integrations: real skills/commands reload with consent; MCP/skill rows report explicit unavailable until headless extraction lands; declarative browser extension UI with terminal-only incompatibility diagnostics.
- Portability: explicit compaction modes with eligibility, durable BTW history with guarded promotion, manifest-backed downloads through the fleet origin, SessionScope-bound voice control rows over the existing SSE stream, and targeted resume/pins/foreign import.

### Fixes
- Subagents: the worker hub lists live subagents again (it filtered by the SDK session uuid instead of the attached handle, so it opened empty while the status bar counted them); rows and the focused worker header show the spawned subagent name beside its agent type, in-flight glyphs spin, and progress updates key on the subagent id so equal indexes from separate task calls no longer merge and status/task changes re-render.
- Subagent hub layout: the filter toolbar and Goals/Advisor control rows no longer reserve 260px of height each (the steer-cluster flex basis now applies only inside a worker row); underlined tabs, a single-line wrapping toolbar, a wider dialog, and rows that truncate the description and model instead of overflowing.
- Worker detail view: no longer wipes and refetches the transcript on every subagent frame (the scope-reset effect tracked an unmemoized key over a per-frame `sub` object), which made the view flicker between the transcript and "loading…"; its header wraps instead of squeezing the back button.
- Subagent lists (task card, active strip, worker hub) render rows keyed by subagent id instead of per-frame objects, so rows no longer remount on every progress frame: spinners rotate smoothly, clicks on a row open its detail view, and the hub keeps a stable order (in-flight first) instead of reshuffling by last update.


### Maintenance & other
- Move application source to `apps/{cli,fleet,session,web}`, shared libraries to `lib/*`, cross-app E2E to `e2e/`, and tooling tests to `scripts/test/`; enforce the closed `lib/` import boundary in lint.
- Remove the optional benchmark harness, its `bench` command, and local benchmark outputs; ordinary test execution is unchanged.
- Make development auth broker management opt-in via `bun run dev --auth-broker`; default dev starts only the fleet and Vite and preserves explicitly configured broker environment variables and provider-profile secret references.
- Bump all seven imported `@oh-my-pi/*` SDK packages together to unpatched 18.6.1.
- Migrate live settings to SDK registry handles and provider authentication to the namespaced OAuth login and effective credential-source APIs, preserving settings scope and browser login dialogs.

### Bug fixes
- Keep streaming active and completion markers unset through non-yielded `agent_end` events; mark a turn complete only when the agent yields.
- Read the latest `omp stats` summary from stderr, align profile and existing flattened XDG paths, pin sync children to the viewer's resolved targets, and correct the CLI install hint to `@oh-my-pi/pi-coding-agent`.
- Apply the thinking level of a `default` role assigned or cleared in the model roles picker to the live session, matching the TUI model hub; previously only the saved role value changed and the session bar kept the old level.

## v0.2.1, 2026-09-25

omp-web 0.2.1 uses the unpatched SDK and removes the legacy migration path.

### Maintenance & other
- Use the unpatched SDK and remove the legacy migration path. ([df29af5942edb39d4b23e8f232e4803a63022b07](https://github.com/nibblebot/omp-web/commit/df29af5942edb39d4b23e8f232e4803a63022b07))

## v0.2.0, 2026-09-21

omp-web 0.2.0 removes the standalone single-session web UI mode, with omp-session now serving the wire API only. It adds preflight drift reports, gate E2E and packed-artifact smoke tests, and main-based docs deployment, plus fixes including an SDK bump to 18.2.6 with patched tokenizer estimates and at-most-once replay of unanswered calls.

### Breaking changes
- refactor(fleet)!: make the fleet the only web UI server ([b5a158f89bb4e3c53e1f7763969f09ebf19be3e7](https://github.com/nibblebot/omp-web/commit/b5a158f89bb4e3c53e1f7763969f09ebf19be3e7))

### Features
- Add preflight drift reports, gate E2E, packed-artifact smoke tests, and main-based docs deploy ([cc459b76a95e55e1637da037ed6d2ea8407e4a78](https://github.com/nibblebot/omp-web/commit/cc459b76a95e55e1637da037ed6d2ea8407e4a78))
- Route the preflight verb through the CLI and pin pi-catalog explicitly ([193b80757fce25b78ab6f61c1a483c394cb813ec](https://github.com/nibblebot/omp-web/commit/193b80757fce25b78ab6f61c1a483c394cb813ec))
- Run the auth broker together with the fleet dev stack ([d756e6916a8c0d30f4ff61426f505fd1066d2beb](https://github.com/nibblebot/omp-web/commit/d756e6916a8c0d30f4ff61426f505fd1066d2beb))
- Add provider-managed clone workspaces to the fleet ([9726067035351733696ac3ebc6d9af7377897b23](https://github.com/nibblebot/omp-web/commit/9726067035351733696ac3ebc6d9af7377897b23))
- Publish the documentation site to GitHub Pages ([ac43d6b92749b6e5faf6c18ba08fc3f82c5c8bbd](https://github.com/nibblebot/omp-web/commit/ac43d6b92749b6e5faf6c18ba08fc3f82c5c8bbd))
- Add a work and analysis mode switcher with persistent transcripts sidebar ([c06eab7a965424a24fa3b292f21309713e92f5c6](https://github.com/nibblebot/omp-web/commit/c06eab7a965424a24fa3b292f21309713e92f5c6))
- Add a usage-in-sidebar setting with a condensed sidebar usage widget ([396e2f88db9b02475f572fe3b9d15241a259588c](https://github.com/nibblebot/omp-web/commit/396e2f88db9b02475f572fe3b9d15241a259588c))

### Bug fixes
- Bump the agent SDK to 18.2.6, patch tokenizer estimates, and replay unanswered calls at most once ([571653b0c34a74e2b3e34b3dce07677549df1d34](https://github.com/nibblebot/omp-web/commit/571653b0c34a74e2b3e34b3dce07677549df1d34))
- Repair two pre-existing test failures ([efe8e84bf6d6a13711a786c595b489fbbc268ba0](https://github.com/nibblebot/omp-web/commit/efe8e84bf6d6a13711a786c595b489fbbc268ba0))
- Serve a placeholder page when no web bundle is embedded ([8186acf0aee9cbfacee39ca70b7865074abb8f2d](https://github.com/nibblebot/omp-web/commit/8186acf0aee9cbfacee39ca70b7865074abb8f2d))

### Maintenance & other
- Document clone workspaces, browser auth, and sandbox runtimes ([ba26ea23abe2c9575a5a984959b27b12ac5ed3ab](https://github.com/nibblebot/omp-web/commit/ba26ea23abe2c9575a5a984959b27b12ac5ed3ab))
- Remove the last em dashes, including those in the changelog ([c12a64abb0faac269c33123d11ca55cc972d20c8](https://github.com/nibblebot/omp-web/commit/c12a64abb0faac269c33123d11ca55cc972d20c8))
- Strip AI writing tells from the clone-workspace branch ([dacc2ca1360a8373b157c6851f7c1de0c4e0f393](https://github.com/nibblebot/omp-web/commit/dacc2ca1360a8373b157c6851f7c1de0c4e0f393))
- Commit the clone workspace design, plan, and summary ([0e367045758e8048411e50492f9d50f1a179315a](https://github.com/nibblebot/omp-web/commit/0e367045758e8048411e50492f9d50f1a179315a))
- Strip AI writing tells from comments, strings, and prose ([a9405ee4f0709674362cedf922fadbb7d4b2d0dd](https://github.com/nibblebot/omp-web/commit/a9405ee4f0709674362cedf922fadbb7d4b2d0dd))
- Drop the Docker session-daemon guide ([0080da1a538324e8bf1daca244bd430e68cb35ef](https://github.com/nibblebot/omp-web/commit/0080da1a538324e8bf1daca244bd430e68cb35ef))
- Remove fleet/examples and inline the docker wrapper ([6306f21eed9e40b95e4e7ec10a6dc2b943d12f55](https://github.com/nibblebot/omp-web/commit/6306f21eed9e40b95e4e7ec10a6dc2b943d12f55))
- Build the Starlight documentation site ([07cd0b22e06fc822b0ee32ad115f234cca11102a](https://github.com/nibblebot/omp-web/commit/07cd0b22e06fc822b0ee32ad115f234cca11102a))
- Add issue templates ([22b733a1fd18bfc1c37e044fd263e57e3d33d83e](https://github.com/nibblebot/omp-web/commit/22b733a1fd18bfc1c37e044fd263e57e3d33d83e))
- Require log-file capture for test suite runs ([0d29560927065d7f0490b8e1a2286de71806439b](https://github.com/nibblebot/omp-web/commit/0d29560927065d7f0490b8e1a2286de71806439b))
- Bump runtime and dev dependencies ([6c576d9992b4e4a97359bb6ca1efd753a1882a40](https://github.com/nibblebot/omp-web/commit/6c576d9992b4e4a97359bb6ca1efd753a1882a40))
- Strip em dashes from markdown prose and use commas in changelog headers ([afc5de110fec6f1ca42d04ebd7a2aab9c8851cd2](https://github.com/nibblebot/omp-web/commit/afc5de110fec6f1ca42d04ebd7a2aab9c8851cd2))

## v0.1.1, 2026-08-20

This release fixes two chat issues: pinned chat streams now stay pinned through any content change, and the queued-steer chip is cleared once the steer is delivered. It also improves reliability by replacing a flaky queued-steer end-to-end test with hermetic coverage, and anchors the pinned install directory as its own bun project.

### Bug fixes
- fix(chat): re-pin a pinned stream on ANY content change via content ResizeObserver ([a364b3eaad8e14a3e9b4acfa9ea7906719636c20](https://github.com/nibblebot/omp-web/commit/a364b3eaad8e14a3e9b4acfa9ea7906719636c20))
- fix(server): clear queued-steer chip when the steer is delivered ([dc53303d3ae3351a5bccd009d24fabbb00f3622b](https://github.com/nibblebot/omp-web/commit/dc53303d3ae3351a5bccd009d24fabbb00f3622b))

### Maintenance & other
- test(server): drop flaky queued-steer e2e; hermetic wireSession suite covers the fix ([1ff7e3a5367ec0a428aa766277b9456834b55987](https://github.com/nibblebot/omp-web/commit/1ff7e3a5367ec0a428aa766277b9456834b55987))
- install: anchor pinned install dir as its own bun project ([1774e9cf23d7a79f64475a7d1f3b659c27f5d8d6](https://github.com/nibblebot/omp-web/commit/1774e9cf23d7a79f64475a7d1f3b659c27f5d8d6))

## v0.1.0, 2026-08-20

### Breaking changes
- feat: clamp major bump to minor while at 0.x (appliedBump) ([0591bce94cbb2c1fdd4693aad9dd33b128a0fc89](https://github.com/nibblebot/omp-web/commit/0591bce94cbb2c1fdd4693aad9dd33b128a0fc89))

### Features
- feat: add bun-only one-liner installer; move release docs to docs/release.md ([52823cdf75bc94ce576a7ce2a669570670e3e462](https://github.com/nibblebot/omp-web/commit/52823cdf75bc94ce576a7ce2a669570670e3e462))
- feat: --stage/--go two-phase release - generate + validate everything, stop for review, publish staged artifacts ([db9e1467dfe7aa8c8e3479180c20c317c70c9ead](https://github.com/nibblebot/omp-web/commit/db9e1467dfe7aa8c8e3479180c20c317c70c9ead))
- feat: --notes-file flag for manual GitHub release notes (changelog section stays the default) ([ac9a901dd27a206fb76a32cb26e93e7d58f9a0c3](https://github.com/nibblebot/omp-web/commit/ac9a901dd27a206fb76a32cb26e93e7d58f9a0c3))
- feat: release machinery - semver bump from commit classes, LLM changelog with deterministic fallback, packaged-release validation, gh release + verify ([bd975638b0f26191a6e4d68581f6bbafa8e7d52a](https://github.com/nibblebot/omp-web/commit/bd975638b0f26191a6e4d68581f6bbafa8e7d52a))
- feat: default the update channel to GitHub releases (env stays as override) ([f272089555d9d907262d852faa704815f435b904](https://github.com/nibblebot/omp-web/commit/f272089555d9d907262d852faa704815f435b904))
- feat: distill project-group main worktree rows to a root profile ([f8cb54538582bed5e623622410cb05e03972043d](https://github.com/nibblebot/omp-web/commit/f8cb54538582bed5e623622410cb05e03972043d))
- feat: auto-register default workspace when adding a repo ([8cb006f0b8878051ed3fef3c23d287b9e1088f6b](https://github.com/nibblebot/omp-web/commit/8cb006f0b8878051ed3fef3c23d287b9e1088f6b))
- feat: evict roster worktrees removed on disk + deletion toast ([1106e4d2b805e9895c68995e2850576630d01eed](https://github.com/nibblebot/omp-web/commit/1106e4d2b805e9895c68995e2850576630d01eed))
- feat: per-worktree dev fleet state under data-home dev-fleets/ ([aeeb40d7290d2944a48650e8669a0f7ec4de69af](https://github.com/nibblebot/omp-web/commit/aeeb40d7290d2944a48650e8669a0f7ec4de69af))
- feat: character sprites in model role picker; remove corner pet panel ([cebfb869bfd920552131bf6c0ce197704ad98466](https://github.com/nibblebot/omp-web/commit/cebfb869bfd920552131bf6c0ce197704ad98466))
- feat: first-run offer, data-home config, onboarding UI ([10d569d22906c51cc7b3ef45a7dafa0d5ce9a127](https://github.com/nibblebot/omp-web/commit/10d569d22906c51cc7b3ef45a7dafa0d5ce9a127))
- feat: omp-web entrypoint, installable bundle, pinned install, self-update ([ef5d4cd86dc0f8a81bc82b34885a5bac1df6d765](https://github.com/nibblebot/omp-web/commit/ef5d4cd86dc0f8a81bc82b34885a5bac1df6d765))
- feat: directory picker and fleet roots removal ([dc551346466339d61f180e4d3443c9a865a5cba5](https://github.com/nibblebot/omp-web/commit/dc551346466339d61f180e4d3443c9a865a5cba5))
- feat: consolidate home data into ~/.ompweb and lock state files ([af33806f9fa2663c3f9bca1ad44c7500ddfb6571](https://github.com/nibblebot/omp-web/commit/af33806f9fa2663c3f9bca1ad44c7500ddfb6571))
- feat: branch picker in the add-worktree modal - select an existing branch, no freeform ref entry ([eebfc5d808b0e8d053e8e0c55a0f0e2dd826ea9a](https://github.com/nibblebot/omp-web/commit/eebfc5d808b0e8d053e8e0c55a0f0e2dd826ea9a))
- feat: sidebar rework - docked panel, kebab action menus, diffstat git meta ([89e88662ddc10ffd4f43a21410aa90e64418056d](https://github.com/nibblebot/omp-web/commit/89e88662ddc10ffd4f43a21410aa90e64418056d))
- feat: replace unicode glyph icons with vendored Lucide SVG components ([ba53150ab230d727ecd61794d5e5b447c7388b7c](https://github.com/nibblebot/omp-web/commit/ba53150ab230d727ecd61794d5e5b447c7388b7c))
- feat: project/worktree onboarding - registered projects, managed worktrees, close-out ladder ([db267a0edc1e03492d739aeaa9fbd2ccac3a9d7a](https://github.com/nibblebot/omp-web/commit/db267a0edc1e03492d739aeaa9fbd2ccac3a9d7a))
- feat: declutter header - drop idle dot, relocate tool-expand and chrome buttons ([394174a1065515472864683c279feab0e5cdaa03](https://github.com/nibblebot/omp-web/commit/394174a1065515472864683c279feab0e5cdaa03))
- feat: per-run random ports for dev servers with bounded retry ([64c6b9d9940feade33fcdde16368bd2240789b49](https://github.com/nibblebot/omp-web/commit/64c6b9d9940feade33fcdde16368bd2240789b49))
- feat: reveal queue defaults on ([52be475b0de5036a0397eecd950f30d47c8e6ed8](https://github.com/nibblebot/omp-web/commit/52be475b0de5036a0397eecd950f30d47c8e6ed8))
- feat: shimmering in-progress working label in the session stream ([501436439da340fff8ae52399718ce5afbf072a9](https://github.com/nibblebot/omp-web/commit/501436439da340fff8ae52399718ce5afbf072a9))
- feat: unified rem type ramp - one scale, smaller steps, tx on the dial ([6fcbcac7acd404cb1f9b7897e74f491e32d5c5e0](https://github.com/nibblebot/omp-web/commit/6fcbcac7acd404cb1f9b7897e74f491e32d5c5e0))
- feat: two-voice type hierarchy and uniform strip cadence ([7951faba1c14c993b2c6412c3e7e863158f415c6](https://github.com/nibblebot/omp-web/commit/7951faba1c14c993b2c6412c3e7e863158f415c6))
- feat: pin session identity above the stream, send config above the composer ([26bf1794e34a26c0355c6e94c7f44bb28ac9cf44](https://github.com/nibblebot/omp-web/commit/26bf1794e34a26c0355c6e94c7f44bb28ac9cf44))
- feat: fold historical transcripts/stats browser into roster mode ([8d90591876d83e4be152985464c04b3cefee5f1b](https://github.com/nibblebot/omp-web/commit/8d90591876d83e4be152985464c04b3cefee5f1b))
- feat: model roles picker with per-role model/thinking persisted to config.yml ([a83e33aed4659862b4209b8a6321277e2d948fa1](https://github.com/nibblebot/omp-web/commit/a83e33aed4659862b4209b8a6321277e2d948fa1))
- feat: consolidate full assistant turns into one run row with summary metrics ([5bd45f6730033c1b0c407f0cd21c733666451380](https://github.com/nibblebot/omp-web/commit/5bd45f6730033c1b0c407f0cd21c733666451380))
- feat: add consolidated tool card view grouping tools and thinking ([048a770182e0149134a8b1b56ae1a87723d48f89](https://github.com/nibblebot/omp-web/commit/048a770182e0149134a8b1b56ae1a87723d48f89))
- feat: add toggleable collapsed tool card view in stream ([1e8aa93e5013527a65155427e9cf6da5c31378e4](https://github.com/nibblebot/omp-web/commit/1e8aa93e5013527a65155427e9cf6da5c31378e4))
- feat: settings panel works in roster mode with no daemon attached ([b1b10a729f67d5c4f8a3dc4c810797798159d77b](https://github.com/nibblebot/omp-web/commit/b1b10a729f67d5c4f8a3dc4c810797798159d77b))
- feat: fleet observability - lifecycle logging, /ctl/debug, UI debug panel, cleaner dev:fleet output ([927621b207bcbb3bde39f1dba3f566c5d24ecb92](https://github.com/nibblebot/omp-web/commit/927621b207bcbb3bde39f1dba3f566c5d24ecb92))
- feat: sidebar groups sessions under Repos with branch and dirty git state ([e8d5f65ac4250c433b835e2fcf217b2c61de9455](https://github.com/nibblebot/omp-web/commit/e8d5f65ac4250c433b835e2fcf217b2c61de9455))
- feat: replace WebSocket transport with POST + SSE (OMP_PROTO 2) ([84ae1b6f9b17efbad659c58ff28954706d2225f4](https://github.com/nibblebot/omp-web/commit/84ae1b6f9b17efbad659c58ff28954706d2225f4))
- feat: roster groups sessions by owning repo, tags worktree cwds ([6794bb43a1b28be4a64047856f2545ce669b878e](https://github.com/nibblebot/omp-web/commit/6794bb43a1b28be4a64047856f2545ce669b878e))
- feat: kill/remove sessions from the fleet roster ([35ba95898599f21245a3ef2bd95d97a0a3af19a1](https://github.com/nibblebot/omp-web/commit/35ba95898599f21245a3ef2bd95d97a0a3af19a1))
- feat: dev:fleet spawns sessions from source via OMP_FLEET_LOCAL_TEMPLATE ([4aa3bfb215e9ca08fa83a0e24357a93aff054fac](https://github.com/nibblebot/omp-web/commit/4aa3bfb215e9ca08fa83a0e24357a93aff054fac))
- feat: one-command dev runner with fleet HMR, LAN flags, wss fix ([9c62be06a6c3d6ac5d5bb40ac9efcf8c1ae8f728](https://github.com/nibblebot/omp-web/commit/9c62be06a6c3d6ac5d5bb40ac9efcf8c1ae8f728))
- feat: standalone ompd daemon + orchestrator edge with daemon sidebar ([eabc657cc4d3339c9cff2ab667dc126d3d1b1259](https://github.com/nibblebot/omp-web/commit/eabc657cc4d3339c9cff2ab667dc126d3d1b1259))
- feat: daemon port chip + kill/restart controls on the live-daemons strip ([3d2ab279eb7a89ac38feae53ac81d409e68940de](https://github.com/nibblebot/omp-web/commit/3d2ab279eb7a89ac38feae53ac81d409e68940de))
- feat: daemon web exposure, first-run empty state, shared tool-card shell ([b883660166dfff52946d12c2628cf6e82fffab59](https://github.com/nibblebot/omp-web/commit/b883660166dfff52946d12c2628cf6e82fffab59))
- feat: collab TUI-mux - omp join rooms for daemon sessions ([5f7855d0c4e98f7b39680332910535d6d8c4d381](https://github.com/nibblebot/omp-web/commit/5f7855d0c4e98f7b39680332910535d6d8c4d381))
- feat: role roster on the pet - resolved model roles with stacked labels ([febeee7a81a2d4946de9cd120ed4c0577930b8c2](https://github.com/nibblebot/omp-web/commit/febeee7a81a2d4946de9cd120ed4c0577930b8c2))
- feat: minimax + deepseek pixel-art pets, provider-matched pet and session avatars ([55de3d8aa164865fb7dd4bdf7100fe4f9eab0090](https://github.com/nibblebot/omp-web/commit/55de3d8aa164865fb7dd4bdf7100fe4f9eab0090))
- feat: show active subagents and daemon broker roster in sidebar ([ff46e786e945b3c75d861e72d3074b02e80c5865](https://github.com/nibblebot/omp-web/commit/ff46e786e945b3c75d861e72d3074b02e80c5865))

### Bug fixes
- fix(release): accept staged CHANGELOG.md add in --go publish ([37f859e928a0270f918ec93a11cc7d2ac078d2b3](https://github.com/nibblebot/omp-web/commit/37f859e928a0270f918ec93a11cc7d2ac078d2b3))
- fix(release): render changelog commits as markdown bullets ([1931a54f1f33ebb9e4fb6e52249c9ab838aea1db](https://github.com/nibblebot/omp-web/commit/1931a54f1f33ebb9e4fb6e52249c9ab838aea1db))
- fix(chat): gesture-owned sticky scroll; icon-only jump button ([f6ee5a34552c8fa62290354f38f531d0b5c1f9c5](https://github.com/nibblebot/omp-web/commit/f6ee5a34552c8fa62290354f38f531d0b5c1f9c5))
- fix(release): strip newline git appends after log record separators ([d8516606038d852cff8836e576755db2b8cd40df](https://github.com/nibblebot/omp-web/commit/d8516606038d852cff8836e576755db2b8cd40df))
- fix(release): keep LLM changelog bullets on one line ([134ded938b9ecce03af64cacf5d0022ffe85cd3c](https://github.com/nibblebot/omp-web/commit/134ded938b9ecce03af64cacf5d0022ffe85cd3c))
- fix: chunk LLM changelog turns per group - bounded prompts + merge, overview turn, timeout aborts ([5d4003802b8fc88718abded978940d2c9cccd0e8](https://github.com/nibblebot/omp-web/commit/5d4003802b8fc88718abded978940d2c9cccd0e8))
- fix: sticky-bottom stream scrolling with jump-to-bottom affordance ([4368fa61289a1e2bc397ba4af0630145df049932](https://github.com/nibblebot/omp-web/commit/4368fa61289a1e2bc397ba4af0630145df049932))
- fix: Enter submits the add-worktree modal - wrap create tab in a <form> ([2e548b5678a40d210bdb8f6cb8f931fff752c562](https://github.com/nibblebot/omp-web/commit/2e548b5678a40d210bdb8f6cb8f931fff752c562))
- fix: replace remaining unicode glyphs with Lucide icons - delete-worktree (trash-2), remove-project (x), back-to-main (arrow-left) ([9534c5096cf22d60dd0e9965e7bfbc2ab3fc52be](https://github.com/nibblebot/omp-web/commit/9534c5096cf22d60dd0e9965e7bfbc2ab3fc52be))
- fix: settings panel body padding, right-aligned controls, sidebar footnote, mobile section dropdown ([c140f05ba78acbc9a99c256bbc5206045efac71a](https://github.com/nibblebot/omp-web/commit/c140f05ba78acbc9a99c256bbc5206045efac71a))
- fix: session-first wheel scrolling and cross-browser font parity ([55fa172fba98a094b61b5541f384cb4ca1782aca](https://github.com/nibblebot/omp-web/commit/55fa172fba98a094b61b5541f384cb4ca1782aca))
- fix: audit remediation round 2 - live regions, AA contrast, targets ([dd715391421f4762f0305601d1f8c371ba500c99](https://github.com/nibblebot/omp-web/commit/dd715391421f4762f0305601d1f8c371ba500c99))
- fix: design audit remediation - a11y, contrast, responsive, perf ([f3649dfb5ac0cf10ad17e994ad9c87238ff61079](https://github.com/nibblebot/omp-web/commit/f3649dfb5ac0cf10ad17e994ad9c87238ff61079))
- fix: harden the danger model - modal confirms and resilient arm state ([83413356a6e41fac0350080789df5e63394caa2a](https://github.com/nibblebot/omp-web/commit/83413356a6e41fac0350080789df5e63394caa2a))
- fix: activate sidebar row instantly on asleep-row click ([31d5ff4e54aa8d5a4db4e38795daa1fb08226c35](https://github.com/nibblebot/omp-web/commit/31d5ff4e54aa8d5a4db4e38795daa1fb08226c35))
- fix: audit remediation phases 0-6 - 58 findings, 471/471 green ([bbd30ec3e29c32d6d50d35358835a6d5ece0ad43](https://github.com/nibblebot/omp-web/commit/bbd30ec3e29c32d6d50d35358835a6d5ece0ad43))
- fix: prompt/attach to idle-dropped daemons redial instead of failing ([79f56b47078eb261c57e7e47351bd72010e7250d](https://github.com/nibblebot/omp-web/commit/79f56b47078eb261c57e7e47351bd72010e7250d))
- fix: dev session idle exit no longer nukes dev:fleet ([b67eb563388fb665354e72213fc41d43c31039f2](https://github.com/nibblebot/omp-web/commit/b67eb563388fb665354e72213fc41d43c31039f2))

### Maintenance & other
- docs: polish README install verification and comment alignment ([20e78e7ccfdaa505f3aa6678e2b4df071f6e1326](https://github.com/nibblebot/omp-web/commit/20e78e7ccfdaa505f3aa6678e2b4df071f6e1326))
- docs: add MIT LICENSE and CONTRIBUTING.md ([2ae8c2e0cc4a206b612cdd2e04f0d26848e4c834](https://github.com/nibblebot/omp-web/commit/2ae8c2e0cc4a206b612cdd2e04f0d26848e4c834))
- style: format scripts/dev.ts with oxfmt ([1f4ff0bd1df7727ed97051e7252f6cc7a9bc8b66](https://github.com/nibblebot/omp-web/commit/1f4ff0bd1df7727ed97051e7252f6cc7a9bc8b66))
- docs: update demo screenshot to 800px gif ([6cbedd16e55e75dcbca18d7bc948ae49277cf72d](https://github.com/nibblebot/omp-web/commit/6cbedd16e55e75dcbca18d7bc948ae49277cf72d))
- docs: update demo screenshot ([d5b5a246039ab518bfa64d0ac3f1a34ac30bbe52](https://github.com/nibblebot/omp-web/commit/d5b5a246039ab518bfa64d0ac3f1a34ac30bbe52))
- docs: warn about early-stage codebase in README ([fb66d3339edd36af506f796b4dc0cfbc0b6d720e](https://github.com/nibblebot/omp-web/commit/fb66d3339edd36af506f796b4dc0cfbc0b6d720e))
- docs: reorganize README - move manual install to its own section, promote Advanced to H2 ([a4c15814ee3ee0a4f7421ff6111086ae57308d00](https://github.com/nibblebot/omp-web/commit/a4c15814ee3ee0a4f7421ff6111086ae57308d00))
- dev: fork main-worktree fleet state by default; add --fresh and --state-from ([8aa73ca918d4dec16d80c8940cef2a30eee420b0](https://github.com/nibblebot/omp-web/commit/8aa73ca918d4dec16d80c8940cef2a30eee420b0))
- Mobile sidebar: slide-out overlay instead of docked column ([6555e19ff7b650cb42faea7e1701da59677fa4a3](https://github.com/nibblebot/omp-web/commit/6555e19ff7b650cb42faea7e1701da59677fa4a3))
- style: fix oxfmt formatting in release-llm test ([d9aef9bd8748d0f211639cad9460e667cff1d13f](https://github.com/nibblebot/omp-web/commit/d9aef9bd8748d0f211639cad9460e667cff1d13f))
- docs: simplify README - move self-update up, prune env/behavior sections ([74667d4d69f55acb13888777987be1062aabde6e](https://github.com/nibblebot/omp-web/commit/74667d4d69f55acb13888777987be1062aabde6e))
- refactor: simplify release scripts and provider examples ([5a33930e3d6d7ae8712bdefccd8a9d288fb34221](https://github.com/nibblebot/omp-web/commit/5a33930e3d6d7ae8712bdefccd8a9d288fb34221))
- docs: refresh agent docs, prune research notes, update README wording ([d2c3df429028c0d161562bb69ff94ddfbf61e732](https://github.com/nibblebot/omp-web/commit/d2c3df429028c0d161562bb69ff94ddfbf61e732))
- docs: add omp-web demo gif to README ([6cffbe6ff3a45a343a15eac3e11bf73ba1754ae1](https://github.com/nibblebot/omp-web/commit/6cffbe6ff3a45a343a15eac3e11bf73ba1754ae1))
- docs: release plan rev 2 - semantic bump + LLM changelog ([9ab796055023bb4b191d9feabb655e8fa8b24e7e](https://github.com/nibblebot/omp-web/commit/9ab796055023bb4b191d9feabb655e8fa8b24e7e))
- chore: oxfmt drift in fleet files (release gate format:check) ([36ddde7252a5b55dcff8acd4459a4738dbd1429d](https://github.com/nibblebot/omp-web/commit/36ddde7252a5b55dcff8acd4459a4738dbd1429d))
- Roster session dropdown: resume from sidebar, New session title ([0f45a6ad1bfc6c27bbb620cc2cb2a2fcbe3b102f](https://github.com/nibblebot/omp-web/commit/0f45a6ad1bfc6c27bbb620cc2cb2a2fcbe3b102f))
- ui: view-gated unreviewed dot - flags turns that ended while scrolled up ([41b7a22b9aee7d4f2c4c2e57bc71c76d61ca47de](https://github.com/nibblebot/omp-web/commit/41b7a22b9aee7d4f2c4c2e57bc71c76d61ca47de))
- chat: consolidate only tools/thinking in run rows, keep assistant cards ([adca258ce4ffafe6da47c4eb246d17e595d7efc5](https://github.com/nibblebot/omp-web/commit/adca258ce4ffafe6da47c4eb246d17e595d7efc5))
- test+fix: hermetic fleet suites against dev-shell env; await async provider filter ([43ccc070bc7928ef79dba326414f04054b646cf2](https://github.com/nibblebot/omp-web/commit/43ccc070bc7928ef79dba326414f04054b646cf2))
- fleet+ui: realtime per-daemon activity + unread dot for backgrounded sessions ([f23054fdf7a07533ba37a560c462670e55fd384b](https://github.com/nibblebot/omp-web/commit/f23054fdf7a07533ba37a560c462670e55fd384b))
- fleet+ui: clear stale liveness on stop; empty pane when no active session ([c9f08a2b71a57b18852df484f8845b2da35304ee](https://github.com/nibblebot/omp-web/commit/c9f08a2b71a57b18852df484f8845b2da35304ee))
- roster: hide "Stop daemon" for asleep entries in row kebab menu ([fca2330b4d06b84250066a1229604735757535c1](https://github.com/nibblebot/omp-web/commit/fca2330b4d06b84250066a1229604735757535c1))
- docs: rewrite release plan for GitHub first push ([c4e694a4b5e8d7fc4e7efe009dacf406030740e7](https://github.com/nibblebot/omp-web/commit/c4e694a4b5e8d7fc4e7efe009dacf406030740e7))
- chore: retire build:omp-session self-contained binary ([a485a4174174234369929abebc8a8d88d0f589ad](https://github.com/nibblebot/omp-web/commit/a485a4174174234369929abebc8a8d88d0f589ad))
- docs: simplify README with mermaid architecture diagram ([1e35de5b062825df7e700b90d0a390c8150fc295](https://github.com/nibblebot/omp-web/commit/1e35de5b062825df7e700b90d0a390c8150fc295))
- docs: distribution + first-run docs; tsconfig covers cli/; format drift ([433f8bcafdf4055000cd7368a07dc937d4ee03d3](https://github.com/nibblebot/omp-web/commit/433f8bcafdf4055000cd7368a07dc937d4ee03d3))
- test: offline distribution E2E (install -> serve -> spawn -> update) ([ab85f30d4a4e6781d6f95438d1b09144db7e9b8d](https://github.com/nibblebot/omp-web/commit/ab85f30d4a4e6781d6f95438d1b09144db7e9b8d))
- docs: release & onboarding plan - bundle/install, GitHub-first update, first-run setup ([06ef1fe6971692c60ca86b508c2e8bb435a12b38](https://github.com/nibblebot/omp-web/commit/06ef1fe6971692c60ca86b508c2e8bb435a12b38))
- refactor(frontend): split styles.css into per-domain files under src/styles/ ([2996009b4b362c9cdbb2db905ac220c6cdae73d9](https://github.com/nibblebot/omp-web/commit/2996009b4b362c9cdbb2db905ac220c6cdae73d9))
- test: leak-proof tmpdirs, split fleet server/edge suites, add bench harness ([f49503880d9ce8d3b9f5457d2ef2af417d2493d5](https://github.com/nibblebot/omp-web/commit/f49503880d9ce8d3b9f5457d2ef2af417d2493d5))
- refactor(frontend): group flat src modules, dedupe helpers, fix component layering ([c6b344ac439f899bb2b9ae3fcf1b2c0e66aede7e](https://github.com/nibblebot/omp-web/commit/c6b344ac439f899bb2b9ae3fcf1b2c0e66aede7e))
- refactor(frontend): rAF-buffered hot paths, store facade, dir restructure, component splits ([42c7944ef0466a5d0d5431b87efa9583f72eb4dc](https://github.com/nibblebot/omp-web/commit/42c7944ef0466a5d0d5431b87efa9583f72eb4dc))
- docs: add mermaid architecture diagram to architecture.md ([46c50d72cf2525acd1328e44e318c6f8e3550af0](https://github.com/nibblebot/omp-web/commit/46c50d72cf2525acd1328e44e318c6f8e3550af0))
- chore: rename omp-fleet project references to omp-web ([a22e5b7a1592f8e90186a6ad161fc23cfd707739](https://github.com/nibblebot/omp-web/commit/a22e5b7a1592f8e90186a6ad161fc23cfd707739))
- chore: oxlint + oxfmt toolchain, flag-day reformat of TS/TSX ([14047faa0b0352702357fbb281950c1285f2beaa](https://github.com/nibblebot/omp-web/commit/14047faa0b0352702357fbb281950c1285f2beaa))
- refactor: branch picker becomes a dropdown - name input on top, checked-out branches last and disabled ([b9bec475b7916a84e6f74bea382f1cbe4b17d59a](https://github.com/nibblebot/omp-web/commit/b9bec475b7916a84e6f74bea382f1cbe4b17d59a))
- dev: bold the stack-ready summary lines (labels + URLs only) ([40b6e8ca0fb0c14c4e7e7c54b00d52fcc50f8109](https://github.com/nibblebot/omp-web/commit/40b6e8ca0fb0c14c4e7e7c54b00d52fcc50f8109))
- Move roster sidebar to left overlay with floating toggle ([162503a9764b0e4710a18f15196b01ed5026a0ae](https://github.com/nibblebot/omp-web/commit/162503a9764b0e4710a18f15196b01ed5026a0ae))
- docs: reconcile references to retired audit artifacts ([fea7d42c1b88e61c76afeb98f5b28750e4c5baa0](https://github.com/nibblebot/omp-web/commit/fea7d42c1b88e61c76afeb98f5b28750e4c5baa0))
- docs: archive audit plan, move research materials under docs/ ([980ef9913b542307487b7573e312cd16a1b83bda](https://github.com/nibblebot/omp-web/commit/980ef9913b542307487b7573e312cd16a1b83bda))
- docs: critique snapshot for src (35/40, dual-agent) ([607fa658cf3feb50266c44d6dcc0a8e9b07bfc50](https://github.com/nibblebot/omp-web/commit/607fa658cf3feb50266c44d6dcc0a8e9b07bfc50))
- docs: capture design system in DESIGN.md + impeccable sidecar ([d2a35e101cf489b738a60987d49e21dce40ec4ff](https://github.com/nibblebot/omp-web/commit/d2a35e101cf489b738a60987d49e21dce40ec4ff))
- Add harness competitive-landscape research: feature matrix, solo/team phased plan, fleet-vs-TUI inventory ([723a3ebc7bc7f1e0313e736fe33bd85908619529](https://github.com/nibblebot/omp-web/commit/723a3ebc7bc7f1e0313e736fe33bd85908619529))
- docs: add AGENTS.md engineering map for the repo ([a4177a67ba3ef108f4d309dd9af88e460f53c669](https://github.com/nibblebot/omp-web/commit/a4177a67ba3ef108f4d309dd9af88e460f53c669))
- refactor: drop TUI settings section and session-managed dead paths ([432d8e89533214352b2d32cf657cca90dde85bb5](https://github.com/nibblebot/omp-web/commit/432d8e89533214352b2d32cf657cca90dde85bb5))
- docs: product record + architecture/position docs, README restructure, drop stale audit artifacts ([b252176990b2160db5c67ce58654d4e629cbe487](https://github.com/nibblebot/omp-web/commit/b252176990b2160db5c67ce58654d4e629cbe487))
- chore: make `bun dev` launch fleet mode, `bun dev:single` the standalone session ([8886066ced6f945e4c347f3b750db753eb426b15](https://github.com/nibblebot/omp-web/commit/8886066ced6f945e4c347f3b750db753eb426b15))
- test: parallel reliability + speed - 194s/118 fail → 26s green ([6780c6fb5ade56f43a08c6914f823e421a5e391d](https://github.com/nibblebot/omp-web/commit/6780c6fb5ade56f43a08c6914f823e421a5e391d))
- test: deterministic parallel suite, 218s -> 21s ([e8a998707ec2d024a4f1df49f150e372953274a5](https://github.com/nibblebot/omp-web/commit/e8a998707ec2d024a4f1df49f150e372953274a5))
- refactor: rename ompd → omp-session, omp-orchestrator → omp-fleet ([1493e580a80339bf797cfef80560322499537f36](https://github.com/nibblebot/omp-web/commit/1493e580a80339bf797cfef80560322499537f36))
- docs: fold architecture + plans into README, drop superseded plan docs ([c43c1e778f79053786ee3f4fc315182bce7ecd4d](https://github.com/nibblebot/omp-web/commit/c43c1e778f79053786ee3f4fc315182bce7ecd4d))
- sidebar: poll RSS only, drive roster from websocket events ([8e46122e21a4fc07e3b915eeb0d6f888be9e011f](https://github.com/nibblebot/omp-web/commit/8e46122e21a4fc07e3b915eeb0d6f888be9e011f))
- Auto-title sessions from first prompt, show avatar and context stats in sidebar rows ([5c9d6a16a5b72d1bf913f2f94a71c7b19cf24e8d](https://github.com/nibblebot/omp-web/commit/5c9d6a16a5b72d1bf913f2f94a71c7b19cf24e8d))
- settings: TUI section limited to terminal-only settings; sidebar navigation ([fedd0af48152577e588fa31a10a8136699fe3ba0](https://github.com/nibblebot/omp-web/commit/fedd0af48152577e588fa31a10a8136699fe3ba0))
- Phase 12: parity audit - fix /download jail for server-cwd exports, README + plan docs final ([4783e905b8e28b40642a3db75a25114d19fc9c0a](https://github.com/nibblebot/omp-web/commit/4783e905b8e28b40642a3db75a25114d19fc9c0a))
- Phase 11: web-plus - desktop notifications, /btw side panel (runEphemeralTurn), message hover branch/copy, export --themes ([8816e0ff307e830854c10e25ae6e09d3aec89d07](https://github.com/nibblebot/omp-web/commit/8816e0ff307e830854c10e25ae6e09d3aec89d07))
- Phase 10: eval/lsp/hub/ask renderers, inline images (user msgs + tool results), streaming bash/python with chunk frames, $/$$ python mode ([ae150e70dbe9e1cef8a37d547f8881fd14c8e9ce](https://github.com/nibblebot/omp-web/commit/ae150e70dbe9e1cef8a37d547f8881fd14c8e9ce))
- Phase 9: fix goal/plan - direct SDK relay (17.1.8 has no ACP interception for /goal /plan), goalRuntime rows, popover rewire ([a4494c91489da0a01b24f1b79be40f29be00914c](https://github.com/nibblebot/omp-web/commit/a4494c91489da0a01b24f1b79be40f29be00914c))
- Phase 9: status/modes/usage parity - per-turn usage rows, retry countdown badge, goal popover, plan badge, usage panel, context breakdown, fast/computer/vision toggles ([30e617abfe0abe9fa081b63d28a630df1071e88a](https://github.com/nibblebot/omp-web/commit/30e617abfe0abe9fa081b63d28a630df1071e88a))
- Phase 8: session command parity - retry/fork/fresh/handoff/rename/interrupt/dump relays, inline rename, copy buttons ([80bc0172f3050d596035f5908cbab18cb667224d](https://github.com/nibblebot/omp-web/commit/80bc0172f3050d596035f5908cbab18cb667224d))
- Phase 7: queue chips bar with dequeue, -> / => shorthand + /queue, double-Esc branch, Ctrl+R history search ([b28f8e523b7ac1f39aef38bbc8924df88086dcd6](https://github.com/nibblebot/omp-web/commit/b28f8e523b7ac1f39aef38bbc8924df88086dcd6))
- Reformulate parity plan for SDK era: phases 7-12 (queue UI, session commands, modes/usage, renderers, web-plus) ([86ee2e3200696b279f2cd87eb8408fc151a2be80](https://github.com/nibblebot/omp-web/commit/86ee2e3200696b279f2cd87eb8408fc151a2be80))
- Replace RPC bridge with in-process SDK, add multi-session multiplexing and sessions sidebar ([c06d02d0ab893d201f4f3c71ed1299db643b83f1](https://github.com/nibblebot/omp-web/commit/c06d02d0ab893d201f4f3c71ed1299db643b83f1))
- Add Kimi, a 16-bit pixel-art catgirl avatar that animates while streaming ([6c44b3eb058da974c37a8c6d5024e172a892cba0](https://github.com/nibblebot/omp-web/commit/6c44b3eb058da974c37a8c6d5024e172a892cba0))
- Add catppuccin and omp.sh themes with system-default theme switcher ([14af2d95b41973a2c4149eb81c9eec21e1af000d](https://github.com/nibblebot/omp-web/commit/14af2d95b41973a2c4149eb81c9eec21e1af000d))
- Add README with feature summary ([78bec210d2eac1b8e1acf0e17eb756b2f74c2eec](https://github.com/nibblebot/omp-web/commit/78bec210d2eac1b8e1acf0e17eb756b2f74c2eec))
- Mark Phase 6 complete in parity plan ([99a2bf8de23b9edaa22edbaa45634cec89449023](https://github.com/nibblebot/omp-web/commit/99a2bf8de23b9edaa22edbaa45634cec89449023))
- Phase 6: login providers, subagent drill-down, theme + font-size settings ([231448b108edf37f83e3b8f2f5b27e2eaf4289ea](https://github.com/nibblebot/omp-web/commit/231448b108edf37f83e3b8f2f5b27e2eaf4289ea))
- Phase 5: session resume/branch pickers, compaction items, export download with canonical path validation ([4cb34c03d6d27fc3f75b34368a795238873e76dc](https://github.com/nibblebot/omp-web/commit/4cb34c03d6d27fc3f75b34368a795238873e76dc))
- Phase 4: rich tool renderers (bash, diff, read, todo, search, web, task) and subagent plumbing ([456f416e7a684abe84df45ee39824a9afa5af77b](https://github.com/nibblebot/omp-web/commit/456f416e7a684abe84df45ee39824a9afa5af77b))
- Phase 3: status bar segments, model/thinking pickers, stats and settings popovers ([aff579ccdbce7879fd93cbb540fceb31906700a0](https://github.com/nibblebot/omp-web/commit/aff579ccdbce7879fd93cbb540fceb31906700a0))
- Phase 2: slash dispatch, autocomplete, bang-shell, modal ([2b33fd5c6a6878427f033fe02ef0a2eb15fa6c1d](https://github.com/nibblebot/omp-web/commit/2b33fd5c6a6878427f033fe02ef0a2eb15fa6c1d))
- Phase 1: steer/follow-up input, image paste, prompt history, escape abort ([90f4077cf170799785c934567ef523ee07127429](https://github.com/nibblebot/omp-web/commit/90f4077cf170799785c934567ef523ee07127429))
- Phase 0: generic call-relay protocol, full state mirror, reconnect backoff ([a64fe670ee1a9f0d66e251d85db3b903b146d6ba](https://github.com/nibblebot/omp-web/commit/a64fe670ee1a9f0d66e251d85db3b903b146d6ba))
- docs: persist web-tui parity plan with progress tracking ([ca57015755bedc30a0e629d77cd090dc0b1578f2](https://github.com/nibblebot/omp-web/commit/ca57015755bedc30a0e629d77cd090dc0b1578f2))
- Initial commit: omp-web Solid.js frontend with Bun server ([5fc4c5b05a98b96b79420d2cc65380b61bef356b](https://github.com/nibblebot/omp-web/commit/5fc4c5b05a98b96b79420d2cc65380b61bef356b))
