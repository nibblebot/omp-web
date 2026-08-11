#!/usr/bin/env bash
# docker-ompd.sh — ompd-in-docker spawn wrapper (orchestrator/examples).
#
# Usage (invoked by the orchestrator from a spawn template, see docker.json):
#   docker-ompd.sh <cwd> <token> <name> [ompd args...]
# The trailing args are passed VERBATIM to ompd inside the container; the
# supervisor fills {labels} ("--label k=v ...") and {resume} ("--resume <file>")
# into them. The workspace is bind-mounted at its HOST path so the daemon
# reports the same cwd the orchestrator registered (hello_ok cwd check).
#
# Prints the OMPD| contract lines on stdout: the container's real
# "listening" line (streamed via `docker logs -f`) followed by the wrapper's
# own {"event":"endpoint"} line carrying the HOST-published reachable URL.
# The orchestrator's resolver needs a listening line and prefers the wrapper
# endpoint (R6b), so it dials the published port, not the container's
# internal 4721.
#
# SECURITY — dial-in only:
#   * The orchestrator dials INTO the daemon; the container never dials out
#     and never learns the orchestrator's address or state.
#   * The bearer token is minted per spawn by the supervisor and passed on
#     the container command line; it gates ONLY this daemon (ompd's
#     --host 0.0.0.0 bind is a startup hard error without it). Nothing inside
#     the sandbox holds any other daemon's token or orchestrator credentials.
#   * The token is visible via `docker inspect` to anyone who can reach the
#     Docker socket, and in the host process list briefly (single-operator
#     v1 tradeoff, documented in README Phase 6). Restrict Docker socket
#     access accordingly.
set -euo pipefail

CWD="$1"
TOKEN="$2"
NAME="$3"
shift 3

# TODO: build & push your ompd image, then set OMPD_IMAGE or edit here.
IMAGE="${OMPD_IMAGE:-your-registry/ompd:latest}"
OMPD_PORT=4721                      # container-internal port (fixed)
HOST_PORT="${OMPD_HOST_PORT:-}"     # optional explicit published host port

CID="ompd-$(printf '%s' "$NAME" | tr -c 'a-zA-Z0-9_.-' '_')-$OMPD_PORT-$$"

cleanup() {
	docker rm -f "$CID" >/dev/null 2>&1 || true
}
trap cleanup EXIT TERM INT

if [ -n "$HOST_PORT" ]; then
	PORT_SPEC="127.0.0.1:$HOST_PORT:$OMPD_PORT"
else
	# Let docker pick a free host port, then discover it below. Bind on
	# loopback by default (dial-in from the orchestrator's host); use
	# "0.0.0.0::$OMPD_PORT" for a docker host reachable over the network.
	PORT_SPEC="127.0.0.1::$OMPD_PORT"
fi

# Start the container detached; `docker run -d` prints the container id —
# keep it off the OMPD| stream. `--rm` removes the container on exit.
docker run --rm -d --name "$CID" -p "$PORT_SPEC" \
	-v "$CWD:$CWD" -w "$CWD" \
	"$IMAGE" \
	ompd --cwd "$CWD" --port "$OMPD_PORT" --host 0.0.0.0 \
	--token "$TOKEN" --name "$NAME" "$@" >/dev/null

if [ -z "$HOST_PORT" ]; then
	# Docker auto-assigns the host port; discover it (e.g. 127.0.0.1:49153).
	HOST_PORT="$(docker port "$CID" "$OMPD_PORT/tcp" | sed 's/.*://')"
	[ -n "$HOST_PORT" ] || { echo "docker: no published port for $CID" >&2; exit 1; }
fi

# Stream the container's stdout: the real OMPD| lines (incl. "listening")
# flow through to the supervisor's pipe.
docker logs -f "$CID" &
LOGS_PID=$!

# The container's listening line says ws://0.0.0.0:4721, which the
# orchestrator cannot dial; publish the host-side URL instead. The resolver
# prefers this wrapper endpoint over the listening url (R6b).
printf 'OMPD|%s\n' "{\"event\":\"endpoint\",\"url\":\"ws://127.0.0.1:$HOST_PORT\"}"

wait "$LOGS_PID"
