#!/usr/bin/env bash
# provider-skeleton.sh — provision-hook skeleton (fleet/examples).
#
# Wired up as config.spawnHook in ~/.omp/fleet/config.json:
#   { "spawnHook": "/path/to/omp-web/fleet/examples/provider-skeleton.sh" }
# (or OMP_FLEET_SPAWN_HOOK). The fleet runs it via `sh -c`
# with a 60s deadline and env:
#   OMP_HOOK_NAME    — requested daemon name (may be empty)
#   OMP_HOOK_LABELS  — comma-joined k=v labels (may be empty)
# It must print a JSON OBJECT { name?, url, token, cwd? } as its LAST
# non-empty stdout line — that is the enroll handshake: the fleet
# registers { mode:"remote", endpoint:url, token, ... } and dials it.
# Anything else on stdout is ignored; write diagnostics to STDERR.
#
# SECURITY — dial-in only:
#   * The daemon you start NEVER dials out: it only accepts an inbound WS
#     from the fleet. It never learns the fleet's address,
#     state file, or credentials.
#   * The token is minted HERE, passed to the daemon at boot, and returned
#     to the fleet in the JSON. It gates ONLY this daemon — each
#     provisioned daemon gets its own token, and the sandbox (container /
#     remote box) contains no knowledge of any other daemon's token or of
#     the fleet's internals. omp-session enforces it: a non-loopback bind
#     without a token is a startup hard error.
#   * The fleet stores the token in ~/.omp-web/fleet-state.json
#     (chmod 600); keep that file private.
#   * The JSON is the last stdout line — never print the token anywhere else.
set -euo pipefail

NAME="${OMP_HOOK_NAME:-}"
LABELS="${OMP_HOOK_LABELS:-}"   # comma-joined k=v; unused in this skeleton
CWD="${OMP_PROVIDER_CWD:-$HOME}" # where the daemon should run — edit me

# Mint the bearer token (32 random bytes, URL-safe base64). This is the
# ONLY secret this daemon will know, and it exists solely for this daemon.
TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
[ -n "$TOKEN" ] || { echo "provision: failed to mint token" >&2; exit 1; }

# ---- START DAEMON (edit this block for your real provider) --------------
# Default demo: run omp-session directly on this host in the background and
# parse its OMP_SESSION| listening line. For a remote/container provider,
# replace this block with your ssh/docker/cloud invocation (see
# docker-omp-session.sh for the published-port pattern) and keep the JSON
# handshake below unchanged.
#
# The daemon MUST outlive this script: the fleet dials it right
# after the hook exits. The local demo relies on omp-session's own idle exit
# (--idle-timeout, default 30m) to stop it — a real provider should tie
# the daemon to a lifecycle (systemd unit, container --rm, ssh session).
LOG="$(mktemp)"
nohup omp-session --cwd "$CWD" --port 0 --host 127.0.0.1 \
	--token "$TOKEN" --name "$NAME" >"$LOG" 2>&1 &

URL=""
for _ in $(seq 1 100); do # up to ~50s; the fleet allows 60s total
	LINE="$(grep '^OMP_SESSION|' "$LOG" | head -n1 || true)"
	if [ -n "$LINE" ]; then
		URL="$(printf '%s' "${LINE#OMP_SESSION|}" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
		[ -n "$URL" ] && break
	fi
	sleep 0.5
done
[ -n "$URL" ] || { echo "provision: daemon never reported an endpoint" >&2; exit 1; }
# --------------------------------------------------------------------------

# JSON-escape a string minimally (skeleton-grade; fine for names/paths).
json_str() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r//g' -e 's/\n/\\n/g'
}

# LAST non-empty stdout line = the enroll contract { name?, url, token, cwd? }.
printf '{"name":"%s","url":"%s","token":"%s","cwd":"%s"}\n' \
	"$(json_str "$NAME")" "$(json_str "$URL")" "$(json_str "$TOKEN")" "$(json_str "$CWD")"
