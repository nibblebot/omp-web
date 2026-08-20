# Contributing

Thanks for wanting to help with omp-web! Bug reports, feature ideas, and pull requests are all welcome.

## Issues

- **Before opening a bug report**, check the existing issues for a match.
- Include: what you did, what you expected, what happened, and your environment (OS, bun version, how you installed omp-web).
- If you can, paste the relevant error output and the session log if one exists.

## Pull requests

- Keep changes focused, one logical change per PR. If you're planning something large, open an issue first to discuss it.
- Run the checks before submitting:
  - `bun run check:types`
  - `bun run format:check`
  - `bun run test`
- New behavior needs tests. Changes to the wire protocol or the release machinery must follow the conventions in `AGENTS.md`.
- Follow the existing code style (tabs, oxfmt formatting, applied by `bun run format`).

## First-time setup

```sh
bun install        # install dependencies
bun run dev        # roster mode (fleet + UI)
bun run dev:single # standalone mode (single daemon + UI)
```

See `AGENTS.md` for the full engineering map: repo layout, the wire contract, invariants, and verification workflow.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
