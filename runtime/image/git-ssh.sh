#!/bin/sh
# Image-owned SSH transport for in-pod Git (P5.4). Git invokes this script as
# GIT_SSH_COMMAND, so it receives OpenSSH's own argv
# (`git-ssh.sh [-o ...] <user@host> <command>`). No credential is baked into
# the image: the pinned identity and host key arrive only as pod env from
# profile Secret references, are written to 0600 temp files, and are removed
# on every exit path.
#
# -F /dev/null, BatchMode=yes, and IdentitiesOnly=yes make the pinned key the
# only candidate and prevent prompts (the pod has no terminal).
# GlobalKnownHostsFile=/dev/null with the secret-backed UserKnownHostsFile
# makes that file the exclusive host-key authority, so an unexpected host key
# fails the Git operation.
set -eu

if [ -z "${OMP_GIT_SSH_PRIVATE_KEY:-}" ] || [ -z "${OMP_GIT_SSH_KNOWN_HOSTS:-}" ]; then
	echo "git-ssh: OMP_GIT_SSH_PRIVATE_KEY and OMP_GIT_SSH_KNOWN_HOSTS must both come from Secret references" >&2
	exit 1
fi

umask 077
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/omp-git-ssh.XXXXXX")"
cleanup() {
	rm -rf "$tmpdir"
}
trap cleanup EXIT
# A fatal signal would otherwise skip the EXIT trap; clean up and report the
# interrupted transport to Git.
trap 'cleanup; exit 1' HUP INT TERM

key="$tmpdir/id"
known_hosts="$tmpdir/known_hosts"
printf '%s\n' "$OMP_GIT_SSH_PRIVATE_KEY" >"$key"
printf '%s\n' "$OMP_GIT_SSH_KNOWN_HOSTS" >"$known_hosts"
chmod 0600 "$key" "$known_hosts"

ssh -F /dev/null \
	-o BatchMode=yes \
	-o IdentitiesOnly=yes \
	-o StrictHostKeyChecking=yes \
	-o GlobalKnownHostsFile=/dev/null \
	-o UserKnownHostsFile="$known_hosts" \
	-i "$key" \
	"$@"
