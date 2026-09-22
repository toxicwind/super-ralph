#!/usr/bin/env bash
# inspect-resume-state.sh — READ-ONLY durability/resume inspector for super-ralph.
#
# Answers, from .super-ralph/workflow.db alone (never writes):
#   1. Is the DB healthy? (journal_mode, integrity, WAL backlog)
#   2. What is each run's terminal state? (finished/cancelled/failed)
#   3. Which attempts are stuck? (in-progress with a stale heartbeat)
#   4. Which attempts diverge from their run? (attempt in-progress, run terminal)
#   5. What would getResumableTickets() resume? (furthest stage per ticket)
#   6. (--run-id) What is the event trail for one run? (crash forensics)
#
# Nightjar lane use: run after any crash/timeout to decide whether a resume is
# safe, and to catch the "run cancelled but attempt still in-progress" class of
# silent divergence. Additive and read-only: opens the DB via a mode=ro URI.
#
# Usage:
#   inspect-resume-state.sh [DB_PATH] [--run-id RUN_ID] [--stale-min N]
# Defaults: DB_PATH=<repo>/.super-ralph/workflow.db, --stale-min 30
#
# Exit codes: 0 = clean, 1 = usage/db error, 2 = anomalies found (stuck or
# divergent attempts, failed runs, integrity problems). 2 is the signal a
# watchdog or Nightjar health check keys on — it never means "resume is safe".
set -euo pipefail

STALE_MIN=30
RUN_ID=""
DB_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)   RUN_ID="${2:?}"; shift 2 ;;
    --stale-min) STALE_MIN="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) DB_PATH="$1"; shift ;;
  esac
done

if [[ -z "$DB_PATH" ]]; then
  # default: repo containing this script
  DB_PATH="$(cd "$(dirname "$0")/.." && pwd)/.super-ralph/workflow.db"
fi
[[ -f "$DB_PATH" ]] || { echo "DB not found: $DB_PATH" >&2; exit 1; }

# Read-only open. sqlite3 CLI supports URI filenames.
RO="file:${DB_PATH}?mode=ro"
q() { sqlite3 -noheader -separator '|' "$RO" "$1"; }

ANOMALIES=0
note()  { echo "  $*"; }
flag()  { ANOMALIES=1; echo "  !! $*"; }
sec()   { echo; echo "== $* =="; }

sec "DB health"
note "path: $DB_PATH"
note "journal_mode: $(q 'PRAGMA journal_mode;')"
note "quick_check: $(q 'PRAGMA quick_check;' | head -1)"
WAL="${DB_PATH}-wal"
if [[ -f "$WAL" ]]; then
  note "wal_size_bytes: $(stat -c %s "$WAL")"
else
  note "wal_size_bytes: 0 (no -wal sidecar)"
fi

sec "runs by status"
while IFS='|' read -r status n; do note "$status: $n"; done < <(q \
  "SELECT status, COUNT(*) FROM _smithers_runs GROUP BY status ORDER BY 2 DESC;")

sec "non-finished runs"
while IFS='|' read -r run_id status code msg; do
  [[ -n "$run_id" ]] || continue
  [[ "$status" == "finished" ]] && continue
  flag "run $run_id -> $status (error: ${code:-none}: ${msg:0:90})"
done < <(q "SELECT run_id, status,
  json_extract(error_json,'\$.code'),
  replace(substr(json_extract(error_json,'\$.message'),1,120), char(10), ' ')
  FROM _smithers_runs ORDER BY run_id;")

sec "stuck attempts (in-progress, heartbeat older than ${STALE_MIN}m)"
CUTOFF_MS=$(( $(date +%s) * 1000 - STALE_MIN * 60 * 1000 ))
FOUND=0
while IFS='|' read -r run_id node_id iter attempt hb; do
  [[ -n "$run_id" ]] || continue
  FOUND=1
  flag "STUCK run=$run_id node=$node_id iter=$iter attempt=$attempt last_heartbeat_utc=$hb"
done < <(q "SELECT run_id, node_id, iteration, attempt,
  datetime(heartbeat_at_ms/1000,'unixepoch')
  FROM _smithers_attempts
  WHERE state='in-progress' AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ${CUTOFF_MS})
  ORDER BY heartbeat_at_ms;")
[[ $FOUND -eq 0 ]] && note "none"

sec "divergent attempts (attempt in-progress, run already terminal)"
FOUND=0
while IFS='|' read -r run_id node_id attempt rstatus; do
  [[ -n "$run_id" ]] || continue
  FOUND=1
  flag "DIVERGENT run=$run_id (run=$rstatus) node=$node_id attempt=$attempt still in-progress"
done < <(q "SELECT a.run_id, a.node_id, a.attempt, r.status
  FROM _smithers_attempts a JOIN _smithers_runs r ON r.run_id = a.run_id
  WHERE a.state='in-progress' AND r.status IN ('finished','cancelled','failed')
  ORDER BY a.run_id;")
[[ $FOUND -eq 0 ]] && note "none"

sec "failed/cancelled attempts (error codes)"
while IFS='|' read -r run_id node_id attempt state code msg; do
  [[ -n "$run_id" ]] || continue
  note "$run_id/$node_id#$attempt $state code=${code:-none} :: ${msg:0:80}"
done < <(q "SELECT run_id, node_id, attempt, state,
  json_extract(error_json,'\$.code'),
  replace(substr(json_extract(error_json,'\$.message'),1,100), char(10), ' ')
  FROM _smithers_attempts
  WHERE state IN ('failed','cancelled') ORDER BY run_id, node_id, attempt;")

sec "per-ticket furthest stage (what getResumableTickets would see)"
# Mirrors src/durability.ts exactly: (table, suffix, stage) triples, land-ward
# first; the first table holding rows for a ticket wins.
TICKET_ROWS=0
while IFS='|' read -r t suffix stage; do
  exists=$(q "SELECT name FROM sqlite_master WHERE type='table' AND name='$t';")
  [[ -n "$exists" ]] || continue
  rows=$(q "SELECT node_id, MAX(iteration) FROM \"$t\" GROUP BY node_id;" 2>/dev/null)
  [[ -n "$rows" ]] || continue
  while IFS='|' read -r node_id iter; do
    [[ -n "$node_id" ]] || continue
    ticket="${node_id%":$suffix"}"
    if [[ "$ticket" == "$node_id" && "$suffix" != "land" ]]; then continue; fi
    TICKET_ROWS=1
    note "$ticket -> $stage (table $t, iteration $iter)"
  done <<< "$rows"
done <<'TRIPLES'
land|land|land
report|report|report
review_fix|review-fix|review_fix
code_review|code-review|code_review
spec_review|spec-review|spec_review
build_verify|build-verify|build_verify
test_results|test|test
implement|implement|implement
plan|plan|plan
research|research|research
discover|discover|discover
TRIPLES
[[ $TICKET_ROWS -eq 0 ]] && note "(no stage-table rows — nothing for getResumableTickets to resume)"

if [[ -n "$RUN_ID" ]]; then
  sec "event trail for run $RUN_ID (last 30)"
  while IFS='|' read -r seq ts type; do
    [[ -n "$seq" ]] || continue
    note "#$seq $ts $type"
  done < <(q "SELECT seq, ts, type FROM (
      SELECT seq, datetime(timestamp_ms/1000,'unixepoch') AS ts, type
      FROM _smithers_events WHERE run_id='$RUN_ID' ORDER BY seq DESC LIMIT 30
    ) ORDER BY seq;")
fi

echo
if [[ $ANOMALIES -eq 1 ]]; then
  echo "RESULT: anomalies found (exit 2) — review before resuming."
  exit 2
else
  echo "RESULT: clean (exit 0)."
fi
