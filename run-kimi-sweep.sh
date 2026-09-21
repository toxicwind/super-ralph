#!/usr/bin/env bash
# super-ralph launcher — kimi sweep backlog (2026-09-20)
# One-shot work order, NOT a daemon: implements the deduplicated sweep
# backlog from PROMPT-kimi-sweep.md then exits. Relaunch after reboot with:
#   bash /home/toxic/super-ralph/run-kimi-sweep.sh
# Logs: /tmp/super-ralph-kimi-sweep.log
set -euo pipefail
cd /home/toxic/super-ralph
export FLOCK_BYPASS=1  # direct-provider behavior; no flock key on this box
export RALPH_CWD=/home/toxic/sovereign
exec bun run src/cli/index.ts ./PROMPT-kimi-sweep.md \
  --max-concurrency 8 --skip-questions \
  >>/tmp/super-ralph-kimi-sweep.log 2>&1
