#!/usr/bin/env bash
# docker-omp-session.sh — omp-session-in-docker spawn wrapper (fleet/examples).
#
# Usage (invoked by the fleet from a spawn template, see docker.json):
#   docker-omp-session.sh <cwd> <token> <name> [omp-session args...]
# The trailing args are passed VERBATIM to omp-session inside the container;
# the supervisor fills {labels} ("--label k=v ...") and {resume} ("--resume
# <file>") into them. The workspace is bind-mounted at its HOST path so the
# daemon reports the same cwd the fleet registered (hello_ok cwd check).
#
# Prints the OMP_SESSION| contract lines on stdout: the container's real
# "listening" line (streamed via `docker logs -f`) followed by the wrapper's
# own {"event":"endpoint"} line carrying the HOST-published reachable URL.
# The fleet's resolver needs a listening line and prefers the wrapper
# endpoint (R6b), so it dials the published port, not the container's
# internal 4721.
#
# SECURITY — dial-in only:
#   * The fleet dials INTO the daemon; the container never dials out
#     and never learns the fleet's address or state.
#   * The bearer token is minted per spawn by the supervisor and passed on
#     the container command line; it gates ONLY this daemon (omp-session's
#     --host 0.0.0.0 bind is a startup hard error without it). Nothing inside
#     the sandbox holds any other daemon's token or fleet credentials.
#   * The token is visible via `docker inspect` to anyone who can reach the
#     Docker socket, and in the host process list briefly (single-operator
#     v1 tradeoff, documented in README Phase 6). Restrict Docker socket
#     access accordingly.
set -euo pipefail

CWD="$1"
TOKEN="$2"
NAME="$3"
shift 3

# TODO: build & push your omp-session image, then set OMP_SESSION_IMAGE or edit here.
IMAGE="${OMP_SESSION_IMAGE:-your-registry/omp-session:latest}"
OMP_SESSION_PORT=4721               # container-internal port (fixed)
HOST_PORT="${OMP_SESSION_HOST_PORT:-}" # optional explicit published host port

CID="omp-session-$(printf '%s' "$NAME" | tr -c 'a-zA-Z0-9_.-' '_')-$OMP_SESSION_PORT-$$"

cleanup() {
	docker rm -f "$CID" >/dev/null 2>&1 || true
}
trap cleanup EXIT TERM INT

if [ -n "$HOST_PORT" ]; then
	PORT_SPEC="127.0.0.1:$HOST_PORT:$OMP_SESSION_PORT"
else
	# Let docker pick a free host port, then discover it below. Bind on
	# loopback by default (dial-in from the fleet's host); use
	# "0.0.0.0::$OMP_SESSION_PORT" for a docker host reachable over the network.
	PORT_SPEC="127.0.0.1::$OMP_SESSION_PORT"
fi

# Start the container detached; `docker run -d` prints the container id —
# keep it off the OMP_SESSION| stream. `--rm` removes the container on exit.
docker run --rm -d --name "$CID" -p "$PORT_SPEC" \
	-v "$CWD:$CWD" -w "$CWD" \
	"$IMAGE" \
	omp-session --cwd "$CWD" --port "$OMP_SESSION_PORT" --host 0.0.0.0 \
	--token "$TOKEN" --name "$NAME" "$@" >/dev/null

if [ -z "$HOST_PORT" ]; then
	# Docker auto-assigns the host port; discover it (e.g. 127.0.0.1:49153).
	HOST_PORT="$(docker port "$CID" "$OMP_SESSION_PORT/tcp" | sed 's/.*://')"
	[ -n "$HOST_PORT" ] || { echo "docker: no published port for $CID" >&2; exit 1; }
fi

# Stream the container's stdout: the real OMP_SESSION| lines (incl.
# "listening") flow through to the supervisor's pipe.
docker logs -f "$CID" &
LOGS_PID=$!

# The container's listening line says ws://0.0.0.0:4721, which the
# fleet cannot dial; publish the host-side URL instead. The resolver
# prefers this wrapper endpoint over the listening url (R6b).
printf 'OMP_SESSION|%s\n' "{\"event\":\"endpoint\",\"url\":\"ws://127.0.0.1:$HOST_PORT\"}"

wait "$LOGS_PID"
