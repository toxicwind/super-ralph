#!/usr/bin/env bash
# export-attempt-evidence.sh — READ-ONLY attempt-evidence exporter for super-ralph.
#
# Freezes per-attempt evidence for one run into
#   /tmp/evidence-<run>-<node>-i<iter>-a<att>/
# reading ONLY from a COPY of .super-ralph/workflow.db (cp to a temp dir first).
# Never touches the live DB and never writes to the repo.
#
# Each evidence dir contains:
#   run.json         — the _smithers_runs row as JSON
#   attempt.json     — the _smithers_attempts row as JSON (+ exporter classification)
#   events.json      — this attempt's node-filtered _smithers_events trail (by seq)
#   run-events.json  — the full run event trail (by seq), for context
#   SUPERSEDED       — marker, only if a later attempt supersedes this one
#   WOULD_ABANDON    — marker, only if reconcile-on-launch rules would classify
#                      this attempt 'abandoned'. CLASSIFICATION ONLY: per the
#                      design doc, only the reconciler may decide 'abandoned';
#                      this exporter never writes state anywhere.
#   MANIFEST         — db copy timestamp + sha256, per-file checksums,
#                      classification, and provenance notes
#
# Supersede semantics (design doc section 2, retry pattern): attempt N for
# (run_id, node_id, iteration) is SUPERSEDED when a later attempt number exists
# for the same key with started_at_ms NOT NULL — i.e. the retry chain moved on
# and this attempt is no longer the live record. The frozen evidence is kept;
# the marker says "do not treat this as the current attempt".
#
# Would-abandon semantics (design doc section 3.1 staleness rungs,
# classification only, no DB writes):
#   - run terminal (finished/cancelled/failed) + attempt non-terminal -> abandon
#     candidate at ANY heartbeat age (writer provably gone)
#   - run non-terminal + attempt non-terminal + heartbeat NULL or age > 24h ->
#     abandon candidate (no legitimate heartbeat cadence is slower than a day)
# Summary classifications otherwise: healthy (<12m), suspect (12-30m),
# stale (30m-24h), terminal.
#
# Usage:
#   export-attempt-evidence.sh [RUN_ID] [--run-id ID] [--db PATH] [--out-dir DIR]
# Defaults: RUN_ID = latest run by created_at_ms; DB = <repo>/.super-ralph/workflow.db;
#           out dir = /tmp
#
# Exit codes: 0 = success; 1 = usage error, DB copy failed, or the copy failed
# its integrity check. The exporter refuses to run unless the DB copy is
# complete and passes PRAGMA quick_check.
set -euo pipefail

VERSION="1.0.0-nightjar-cycle5"

RUN_ID=""
DB_PATH=""
OUT_ROOT="/tmp"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)  RUN_ID="${2:?missing value for --run-id}"; shift 2 ;;
    --db)      DB_PATH="${2:?missing value for --db}"; shift 2 ;;
    --out-dir) OUT_ROOT="${2:?missing value for --out-dir}"; shift 2 ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    -*) echo "export-attempt-evidence: unknown option: $1" >&2; exit 1 ;;
    *) if [[ -z "$RUN_ID" ]]; then RUN_ID="$1"; else
         echo "export-attempt-evidence: unexpected argument: $1" >&2; exit 1
       fi
       shift ;;
  esac
done

# Identifiers are interpolated into SQL single-quoted literals; reject quotes.
for v in "$RUN_ID" "$DB_PATH" "$OUT_ROOT"; do
  [[ "$v" == *"'"* ]] && { echo "export-attempt-evidence: single quotes not allowed in arguments" >&2; exit 1; }
done

if [[ -z "$DB_PATH" ]]; then
  DB_PATH="$(cd "$(dirname "$0")/.." && pwd)/.super-ralph/workflow.db"
fi
[[ -f "$DB_PATH" ]] || { echo "export-attempt-evidence: DB not found: $DB_PATH" >&2; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || { echo "export-attempt-evidence: sqlite3 not found" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "export-attempt-evidence: sha256sum not found" >&2; exit 1; }
[[ -d "$OUT_ROOT" && -w "$OUT_ROOT" ]] || { echo "export-attempt-evidence: out dir not writable: $OUT_ROOT" >&2; exit 1; }

LIVE_MTIME="$(stat -c %Y "$DB_PATH")"
echo "live_db: $DB_PATH"
echo "live_db_mtime: $LIVE_MTIME (read-only: this script never writes the live DB)"

# ---- Step 1: copy the DB (the only production read is cp), then verify ----
COPY_DIR="$(mktemp -d /tmp/sr-evidence-dbcpy.XXXXXX)"
DB_COPY="$COPY_DIR/workflow.db"
if ! cp -- "$DB_PATH" "$DB_COPY"; then
  echo "export-attempt-evidence: DB copy FAILED — refusing to run" >&2
  rm -rf "$COPY_DIR"; exit 1
fi
[[ -s "$DB_COPY" ]] || { echo "export-attempt-evidence: DB copy is empty — refusing to run" >&2; rm -rf "$COPY_DIR"; exit 1; }
# Copy the WAL sidecar too if present so the snapshot is consistent; -shm is
# transient shared memory and is rebuilt on open, so it is skipped on purpose.
if [[ -f "${DB_PATH}-wal" ]]; then
  cp -- "${DB_PATH}-wal" "${DB_COPY}-wal" \
    || { echo "export-attempt-evidence: WAL sidecar copy FAILED — refusing to run" >&2; rm -rf "$COPY_DIR"; exit 1; }
fi
# Integrity gate on the COPY (never on the live file).
QC="$(sqlite3 -noheader "file:${DB_COPY}?mode=ro" "PRAGMA quick_check;" | head -1)"
[[ "$QC" == "ok" ]] || { echo "export-attempt-evidence: quick_check on DB copy: '$QC' — refusing to run" >&2; rm -rf "$COPY_DIR"; exit 1; }
COPY_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COPY_SHA="$(sha256sum "$DB_COPY" | awk '{print $1}')"
echo "db_copy: $DB_COPY"
echo "db_copy_sha256: $COPY_SHA"
echo "db_copy_ts_utc: $COPY_TS"

# All queries from here on run against the copy, read-only URI.
RO="file:${DB_COPY}?mode=ro"
q() { sqlite3 -noheader -separator '|' "$RO" "$1"; }
q1() { sqlite3 -noheader "$RO" "$1"; }

# ---- Step 2: resolve the run ----
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(q "SELECT run_id FROM _smithers_runs ORDER BY created_at_ms DESC, rowid DESC LIMIT 1;")"
  [[ -n "$RUN_ID" ]] || { echo "export-attempt-evidence: no runs in DB" >&2; exit 1; }
  echo "run_id: $RUN_ID (defaulted to latest by created_at_ms)"
else
  echo "run_id: $RUN_ID"
fi

RUN_JSON="$(q1 "SELECT json_object(
    'run_id', run_id,
    'status', status,
    'created_at_ms', created_at_ms,
    'started_at_ms', started_at_ms,
    'finished_at_ms', finished_at_ms,
    'heartbeat_at_ms', heartbeat_at_ms,
    'runtime_owner_id', runtime_owner_id,
    'workflow_hash', workflow_hash,
    'cancel_requested_at_ms', cancel_requested_at_ms,
    'cancel_request_source', cancel_request_source,
    'error_json', CASE WHEN error_json IS NULL THEN NULL
                       WHEN json_valid(error_json) THEN json(error_json)
                       ELSE error_json END
  ) FROM _smithers_runs WHERE run_id='$RUN_ID';")"
[[ -n "$RUN_JSON" ]] || { echo "export-attempt-evidence: run not found: $RUN_ID" >&2; exit 1; }
RUN_STATUS="$(q "SELECT status FROM _smithers_runs WHERE run_id='$RUN_ID';")"
echo "run_status: $RUN_STATUS"

RUN_EVENTS_JSON="$(q1 "SELECT COALESCE(json_group_array(
    json_object('seq', seq, 'timestamp_ms', timestamp_ms, 'type', type,
      'payload', CASE WHEN json_valid(payload_json) THEN json(payload_json) ELSE payload_json END)
  ), '[]') FROM (SELECT seq, timestamp_ms, type, payload_json
                 FROM _smithers_events WHERE run_id='$RUN_ID' ORDER BY seq);")"
RUN_EVENT_COUNT="$(q "SELECT COUNT(*) FROM _smithers_events WHERE run_id='$RUN_ID';")"
echo "run_events: $RUN_EVENT_COUNT"

# ---- helpers ----
sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
RUN_SAFE="$(sanitize "$RUN_ID")"
NOW_MS=$(( $(date +%s) * 1000 ))

is_terminal_state() { # attempt-state terminal set (design doc section 2)
  case "$1" in succeeded|finished|failed|cancelled|abandoned) return 0 ;; *) return 1 ;; esac
}
is_terminal_run() {
  case "$1" in finished|cancelled|failed) return 0 ;; *) return 1 ;; esac
}
fmt_age() { # ms -> human
  local ms=$1
  [[ -z "$ms" ]] && { printf '-'; return; }
  local s=$(( ms / 1000 ))
  if (( s < 3600 )); then printf '%dm' $(( s / 60 ));
  elif (( s < 86400 )); then printf '%dh%02dm' $(( s / 3600 )) $(( (s % 3600) / 60 ));
  else printf '%dd%02dh' $(( s / 86400 )) $(( (s % 86400) / 3600 )); fi
}

# ---- Step 3: per-attempt evidence ----
SUMMARY=()
N=0
while IFS='|' read -r node iter att state hb started finished; do
  [[ -n "$node" ]] || continue
  # node_id is interpolated into SQL below; refuse quotes (defense in depth —
  # values come from our own DB, but the exporter must never be an injection path).
  [[ "$node" == *"'"* ]] && { echo "export-attempt-evidence: refusing: node_id contains a quote: $node" >&2; exit 1; }
  N=$(( N + 1 ))
  NODE_SAFE="$(sanitize "$node")"
  DIR="$OUT_ROOT/evidence-${RUN_SAFE}-${NODE_SAFE}-i${iter}-a${att}"
  mkdir -p "$DIR" || { echo "export-attempt-evidence: cannot create $DIR" >&2; exit 1; }

  ATT_JSON="$(q1 "SELECT json_object(
      'run_id', run_id, 'node_id', node_id, 'iteration', iteration, 'attempt', attempt,
      'state', state,
      'started_at_ms', started_at_ms, 'finished_at_ms', finished_at_ms,
      'heartbeat_at_ms', heartbeat_at_ms,
      'heartbeat_data_json', CASE WHEN heartbeat_data_json IS NULL THEN NULL
                                  WHEN json_valid(heartbeat_data_json) THEN json(heartbeat_data_json)
                                  ELSE heartbeat_data_json END,
      'error_json', CASE WHEN error_json IS NULL THEN NULL
                         WHEN json_valid(error_json) THEN json(error_json)
                         ELSE error_json END,
      'jj_pointer', jj_pointer, 'jj_cwd', jj_cwd, 'cached', cached,
      'meta_json', CASE WHEN meta_json IS NULL THEN NULL
                        WHEN json_valid(meta_json) THEN json(meta_json)
                        ELSE meta_json END
    ) FROM _smithers_attempts
    WHERE run_id='$RUN_ID' AND node_id='$node' AND iteration=$iter AND attempt=$att;")"
  printf '%s\n' "$ATT_JSON" > "$DIR/attempt.json"
  printf '%s\n' "$RUN_JSON" > "$DIR/run.json"
  printf '%s\n' "$RUN_EVENTS_JSON" > "$DIR/run-events.json"

  EV_JSON="$(q1 "SELECT COALESCE(json_group_array(
      json_object('seq', seq, 'timestamp_ms', timestamp_ms, 'type', type,
        'payload', CASE WHEN json_valid(payload_json) THEN json(payload_json) ELSE payload_json END)
    ), '[]') FROM (SELECT seq, timestamp_ms, type, payload_json
                   FROM _smithers_events
                   WHERE run_id='$RUN_ID' AND json_extract(payload_json,'\$.nodeId')='$node'
                   ORDER BY seq);")"
  printf '%s\n' "$EV_JSON" > "$DIR/events.json"
  EV_COUNT="$(q "SELECT COUNT(*) FROM _smithers_events WHERE run_id='$RUN_ID' AND json_extract(payload_json,'\$.nodeId')='$node';")"

  # Supersede check: later attempt number, same (run, node, iter), started.
  SUPER_BY="$(q "SELECT group_concat(attempt, ',') FROM _smithers_attempts
    WHERE run_id='$RUN_ID' AND node_id='$node' AND iteration=$iter
      AND attempt > $att AND started_at_ms IS NOT NULL;")"
  SUPERSEDED="no"
  if [[ -n "$SUPER_BY" ]]; then
    SUPERSEDED="yes"
    { echo "This attempt is SUPERSEDED."
      echo "A later attempt number exists for the same (run_id, node_id, iteration)"
      echo "with started_at_ms NOT NULL, so the retry chain moved on."
      echo "superseded_by_attempt: $SUPER_BY"
      echo "Semantics: resume-reconciliation-design.md section 2 (retry pattern)."
    } > "$DIR/SUPERSEDED"
  fi

  # Would-abandon classification (design doc section 3.1; exporter never decides).
  CLASS="terminal"; WOULD_ABANDON="no"; WA_REASON=""
  if ! is_terminal_state "$state"; then
    if is_terminal_run "$RUN_STATUS"; then
      CLASS="would-abandon"; WOULD_ABANDON="yes"
      WA_REASON="run-terminal/non-terminal-attempt: run status '$RUN_STATUS' is terminal while attempt state '$state' is not; writer provably gone (design 3.1 step 2)"
    elif [[ -z "$hb" ]]; then
      CLASS="would-abandon"; WOULD_ABANDON="yes"
      WA_REASON="no-heartbeat: non-terminal run, attempt '$state' with NULL heartbeat_at_ms (design 3.1: treated as infinitely stale)"
    else
      AGE_MS=$(( NOW_MS - hb ))
      if (( AGE_MS < 12*60*1000 )); then CLASS="healthy"
      elif (( AGE_MS < 30*60*1000 )); then CLASS="suspect"
      elif (( AGE_MS <= 24*60*60*1000 )); then CLASS="stale"
      else CLASS="would-abandon"; WOULD_ABANDON="yes"
        WA_REASON="heartbeat-dead-24h: heartbeat age $(fmt_age "$AGE_MS") exceeds the 24h death rung on a non-terminal run (design 3.1 step 3)"
      fi
    fi
  fi
  if [[ "$WOULD_ABANDON" == "yes" ]]; then
    { echo "Classification: this attempt WOULD be declared 'abandoned' by the"
      echo "reconcile-on-launch procedure (resume-reconciliation-design.md 3.1)."
      echo "This is an exporter classification, NOT a reconciler decision:"
      echo "nothing was written to the DB; only the reconciler may set 'abandoned'."
      echo "reason: $WA_REASON"
    } > "$DIR/WOULD_ABANDON"
  fi

  # Classification sidecar inside attempt.json for machine readers.
  HB_AGE_MS=""; [[ -n "$hb" ]] && HB_AGE_MS=$(( NOW_MS - hb ))
  CLASS_JSON="$(printf '{"exporter":"%s","classification":"%s","terminal":%s,"superseded":%s,"superseded_by":"%s","would_abandon":%s,"would_abandon_reason":%s,"heartbeat_age_ms":%s}' \
    "$VERSION" "$CLASS" \
    "$(is_terminal_state "$state" && echo true || echo false)" \
    "$([[ "$SUPERSEDED" == yes ]] && echo true || echo false)" \
    "$SUPER_BY" \
    "$([[ "$WOULD_ABANDON" == yes ]] && echo true || echo false)" \
    "$(if [[ -n "$WA_REASON" ]]; then printf '%s' "$WA_REASON" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; else echo null; fi)" \
    "${HB_AGE_MS:-null}")"
  # merge classification into attempt.json (jq may not exist; use python3)
  ATT_JSON="$(printf '%s' "$ATT_JSON" | ATT_CLS="$CLASS_JSON" python3 -c '
import json, os, sys
d = json.loads(sys.stdin.read())
d["_exporter_classification"] = json.loads(os.environ["ATT_CLS"])
print(json.dumps(d, indent=2))')"
  printf '%s\n' "$ATT_JSON" > "$DIR/attempt.json"

  # ---- MANIFEST ----
  {
    echo "# evidence MANIFEST — export-attempt-evidence.sh $VERSION"
    echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "run_id: $RUN_ID"
    echo "node_id: $node"
    echo "iteration: $iter"
    echo "attempt: $att"
    echo "evidence_dir: $DIR"
    echo "db_source: $DB_PATH (live; read via cp only, never written)"
    echo "db_copy_ts_utc: $COPY_TS"
    echo "db_copy_sha256: $COPY_SHA"
    echo "db_copy_path: $DB_COPY"
    echo "classification: $CLASS"
    echo "superseded: $SUPERSEDED"
    echo "would_abandon: $WOULD_ABANDON"
    for f in run.json attempt.json events.json run-events.json SUPERSEDED WOULD_ABANDON; do
      [[ -f "$DIR/$f" ]] && echo "file_sha256: $f $(sha256sum "$DIR/$f" | awk '{print $1}')"
    done
    echo "provenance: read-only export; SUPERSEDED/WOULD_ABANDON are exporter"
    echo "  classifications per resume-reconciliation-design.md sections 2-3."
    echo "  No reconciler decision was applied; the live DB was not modified."
  } > "$DIR/MANIFEST"

  HB_TXT="-"; [[ -n "$hb" ]] && HB_TXT="$(fmt_age "$HB_AGE_MS")"
  TERM_TXT="no"; is_terminal_state "$state" && TERM_TXT="yes"
  SUMMARY+=("$(printf '%-28s %4s %3s %-12s %-8s %-8s %-10s %-12s %6s' \
    "$node" "$iter" "$att" "$state" "$HB_TXT" "$TERM_TXT" "$SUPERSEDED" "$CLASS" "$EV_COUNT")|$DIR")
done < <(q "SELECT node_id, iteration, attempt, state,
                   heartbeat_at_ms, started_at_ms, finished_at_ms
            FROM _smithers_attempts WHERE run_id='$RUN_ID'
            ORDER BY node_id, iteration, attempt;")

# ---- Step 4: summary ----
echo ""
echo "== evidence export summary =="
echo "exporter: export-attempt-evidence.sh $VERSION"
echo "attempts exported: $N"
printf '%-28s %4s %3s %-12s %-8s %-8s %-10s %-12s %6s\n' \
  "NODE" "ITER" "ATT" "STATE" "HB_AGE" "TERMINAL" "SUPERSEDED" "CLASS" "EVENTS"
for row in ${SUMMARY[@]+"${SUMMARY[@]}"}; do
  printf '%s\n' "${row%%|*}"
  echo "  -> ${row##*|}"
done
echo "db copy retained at: $COPY_DIR (frozen snapshot sha256=$COPY_SHA)"
echo "live DB untouched: mtime was $LIVE_MTIME at export start (verify with stat)"
exit 0
