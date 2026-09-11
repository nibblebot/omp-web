#!/bin/sh
# Image-owned SSH transport for in-pod Git (P5.4). Git invokes this script as
# GIT_SSH_COMMAND, so it receives OpenSSH's own argv
# (`git-ssh.sh [-o ...] <user@host> <command>`).
#
# No host credential is baked into the image. The operator's pinned identity
# arrives as OMP_GIT_SSH_PRIVATE_KEY and OMP_GIT_SSH_KNOWN_HOSTS pod env from
# profile Secret references; both are expanded into private temporary files
# (mode 0600, umask 077) and removed on every exit path.
#
# Fixed OpenSSH policy: -F /dev/null (ignore every host and user SSH config),
# BatchMode=yes and IdentitiesOnly=yes (the pinned identity is the only
# candidate and nothing can prompt; the pod has no terminal), and
# StrictHostKeyChecking=yes against the pinned known-hosts file, so an
# unexpected host key fails the Git operation instead of being accepted.
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
	-o UserKnownHostsFile="$known_hosts" \
	-i "$key" \
	"$@"
