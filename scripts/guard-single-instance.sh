#!/usr/bin/env bash
# guard-single-instance.sh — fail-loud single-instance guard for the super-ralph outer loop.
#
# Usage: scripts/guard-single-instance.sh [--lockfile PATH] -- <loop command> [args...]
#
# Takes a non-blocking flock(1) on a lockfile before exec'ing the loop command.
# If another outer loop already holds the lock, prints the holder PID (best
# effort) and exits 3 WITHOUT starting a second loop. This enforces the
# "single outer Ralph loop" invariant (cf. fefe4bd collapse of three sibling
# loops) at the launcher layer.
#
# Additive and opt-in: existing launch paths are untouched. Adopt by prefixing:
#   scripts/guard-single-instance.sh -- ./run-kimi-sweep.sh
#
# Exit codes: 0-2 = loop command's own exit (via exec); 3 = another instance
# already holds the lock; 4 = usage error.
set -u

LOCKFILE="/tmp/super-ralph.lock"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --lockfile) LOCKFILE="$2"; shift 2 ;;
    --) shift; ARGS=("$@"); break ;;
    *) echo "usage: $0 [--lockfile PATH] -- <command> [args...]" >&2; exit 4 ;;
  esac
done
[ ${#ARGS[@]} -gt 0 ] || { echo "usage: $0 [--lockfile PATH] -- <command> [args...]" >&2; exit 4; }

# Open the lockfile on a dedicated fd and try a non-blocking exclusive lock.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "guard-single-instance: another super-ralph outer loop is already running; refusing to start a second one." >&2
  HOLDER="$(fuser "$LOCKFILE" 2>/dev/null | tr -s ' ' '\n' | head -1)"
  [ -n "$HOLDER" ] && echo "guard-single-instance: lock held by PID(s): $HOLDER" >&2
  echo "guard-single-instance: if the holder is stale, remove $LOCKFILE and retry." >&2
  exit 3
fi

# We hold the lock on fd 9; exec the loop command with the fd still open so the
# lock is held for the entire lifetime of the loop (released on process exit).
exec "${ARGS[@]}"
