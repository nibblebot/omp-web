---
title: CLI reference
description: "Fleet and session commands: sessions, projects, worktrees, stop and remove selectors, prompt and the collab relay."
---

```sh
omp-web session [options]            # run a single-session agent process
omp-web sessions                    # roster
omp-web projects                    # registered projects
omp-web spawn <path>                 # start a session on a directory
omp-web add-project <path> [--start]    # register a project: any directory, git or not (deduped on realpath)
omp-web add-worktree <project> <name> [--no-start]      # create a worktree
omp-web stop <selector>
omp-web remove <selector>
omp-web rm-project <project>
omp-web rm-worktree <workspace-id> [--delete-branch <name>]
omp-web prompt <selector> <text> [--wait <ms>]
omp-web relay --port <n> [--hostname h] [--max-guests n] [--max-rooms n]   # run the standalone collab relay
```

`stop`, `remove`, and `prompt` selectors accept `all`, an exact workspace ID, `project:name`, or name globs with `*` and `?`; quote globs to prevent shell expansion. Project arguments accept a registered project ID, path/realpath, or basename. Control commands connect to loopback; `--port` or `OMP_FLEET_PORT` selects the fleet port (default 4722). `prompt` to an asleep session wakes it first.

`prompt` submits without waiting unless `--wait <ms>` supplies a result timeout.

`relay` serves collab rooms on its own port (`ws://<host>:<port>`). A session hosts a room through it when `collab.relayUrl` names that URL; `--port` has no default.
