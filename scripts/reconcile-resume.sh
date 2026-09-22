#!/usr/bin/env bash
# reconcile-resume.sh — REPORT-ONLY reconcile-on-launch for super-ralph.
#
# Nightjar lane (super-ralph execution-path reliability), cycle 6.
# Implements the cycle-4 resume-reconciliation-design.md §3 (reconcile-on-launch)
# in REPORT-ONLY mode: it diagnoses run/attempt divergence, classifies it per the
# design's taxonomy (§1) and three-rung staleness table (§3.1), prints the exact
# SQL it WOULD execute (append-first event + state-column repair, §3.1 step 4),
# and evaluates the TicketResume preconditions (§5 P1-P6). It writes NOTHING:
# no writes to the DB, the repo, or any evidence dir.
#
# Safety model:
#   - Works on a COPY of .super-ralph/workflow.db (never the live file).
#   - The copy is PRAGMA quick_check'ed before any query; refusal on failure.
#   - All queries open the copy via a mode=ro URI.
#   - --apply (enforcing mode) is REFUSED by this build: it exits 1 without
#     reading or writing anything. Enforcing needs coordinator sign-off
#     (design §6 Phase 2).
#
# Usage:
#   reconcile-resume.sh --report-only [--db PATH] [--run-id ID]
#
# Exit codes (same watchdog contract as inspect-resume-state.sh):
#   0 = all runs ok
#   1 = usage error, DB copy failure, integrity failure, run not found
#   2 = anomalies found (suspect / stale / would-abandon / zombie-suspect)
# Exit 2 means "review before resuming" — never "resume is safe".
#
# Divergence taxonomy (design §1): 1A run-terminal/attempt-in-progress (the
# accept13 rule), 1B attempt without a run row, 1C state-column/event-trail
# disagreement, 1D stage-row orphan (phantom progress), 1G cancel-without-cause.
# Staleness rungs (design §3.1): <12m healthy, 12-30m suspect, 30m-24h stale,
# >24h would-abandon; a terminal run with a non-terminal attempt is
# would-abandon at ANY heartbeat age (writer provably gone) — except a FRESH
# heartbeat (<12m) with a terminal run, which is a zombie-writer signal and is
# flagged loudly with NO auto-action ever.
set -euo pipefail

RECONCILER_VERSION="1.0.0-report-only"
SUSPECT_MIN=12      # rung 1: suspect below this (minutes)
STALE_MIN=30        # rung 2: stale below this (minutes)
ABANDON_MIN=1440    # rung 3: abandoned at/above this (minutes = 24h)
RUN_TERMINAL="finished cancelled failed"
ATTEMPT_TERMINAL="finished failed cancelled"
ATTEMPT_TERMINAL_EVENTS="NodeFinished NodeFailed NodeCancelled"

MODE="report"
DB_PATH=""
RUN_ID=""

help() {
  cat <<'EOF'
reconcile-resume.sh --report-only [--db PATH] [--run-id ID]

Report-only reconcile-on-launch for super-ralph's checkpoint store
(.super-ralph/workflow.db). Diagnoses run/attempt divergence per the
resume-reconciliation-design.md taxonomy, classifies each divergent run as
ok / suspect / stale / would-abandon / zombie-suspect, prints the exact SQL
the reconciler WOULD execute (text only, never executed), and evaluates the
TicketResume preconditions P1-P6.

Modes:
  --report-only   Diagnose and print the would-write plan. Writes nothing.
                  This is the default and the only authorized mode in this build.
  --apply         REFUSED (exit 1). Enforcing mode needs coordinator sign-off
                  (design §6 Phase 2: backup triple, migration landed, Nightjar ack).
                  Nothing is read or written before the refusal.

Options:
  --db PATH       Database to copy and inspect. Default:
                  <repo>/.super-ralph/workflow.db (repo = script's parent dir).
  --run-id ID     Scope the report to a single run.
  -h, --help      This text.

Safety: operates on a temp COPY of the DB (PRAGMA quick_check'ed, refused if
bad); every query uses a mode=ro URI. The live DB is never opened read-write.

Exit codes: 0 = all ok; 1 = usage/DB-copy/integrity error; 2 = anomalies found.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report-only) MODE="report"; shift ;;
    --apply)
      echo "ERROR: --apply (enforcing mode) is not authorized in this build." >&2
      echo "It requires coordinator sign-off per resume-reconciliation-design.md" >&2
      echo "§6 Phase 2 (backup triple, §4 migration landed, Nightjar ack)." >&2
      echo "Nothing was read or written." >&2
      exit 1 ;;
    --db) DB_PATH="${2:?--db needs a path}"; shift 2 ;;
    --run-id) RUN_ID="${2:?--run-id needs an id}"; shift 2 ;;
    -h|--help) help; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; echo >&2; help >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "$DB_PATH" ]]; then
  DB_PATH="$SCRIPT_DIR/../.super-ralph/workflow.db"
fi
[[ "$RUN_ID" != *"'"* ]] || { echo "ERROR: --run-id contains a single quote" >&2; exit 1; }
[[ "$DB_PATH" != *"'"* ]] || { echo "ERROR: --db path contains a single quote" >&2; exit 1; }
[[ -f "$DB_PATH" ]] || { echo "ERROR: DB not found: $DB_PATH" >&2; exit 1; }

# --- 0. Copy gate: never the live file. Refuse on a bad copy. ---
TMPDIR="$(mktemp -d /tmp/reconcile-resume.XXXXXXXX)"
trap 'rc=$?; rm -rf "$TMPDIR"; exit $rc' EXIT
COPY="$TMPDIR/workflow.db"
cp "$DB_PATH" "$COPY" || { echo "ERROR: DB copy failed" >&2; exit 1; }
[[ -s "$COPY" ]] || { echo "ERROR: DB copy is empty" >&2; exit 1; }
WALSRC="${DB_PATH}-wal"
if [[ -f "$WALSRC" ]] && [[ "$(stat -c %s "$WALSRC")" -gt 0 ]]; then
  cp "$WALSRC" "${COPY}-wal" || { echo "ERROR: WAL sidecar copy failed" >&2; exit 1; }
fi
RO="file:${COPY}?mode=ro"
q() { sqlite3 -noheader -separator '|' "$RO" "$1"; }
sq() { printf '%s' "$1" | sed "s/'/''/g"; }   # SQL string-literal escape

# --- 1. DB health gate (design §3.1 step 1). Failure -> exit 1, no reconciliation. ---
JM="$(q 'PRAGMA journal_mode;')"
[[ "$JM" == "wal" ]] || { echo "ERROR: journal_mode=$JM on DB copy (need wal); refusing" >&2; exit 1; }
QC="$(q 'PRAGMA quick_check;' | head -1)"
[[ "$QC" == "ok" ]] || { echo "ERROR: quick_check=$QC on DB copy; refusing" >&2; exit 1; }
if [[ -n "$RUN_ID" ]]; then
  FOUND="$(q "SELECT COUNT(*) FROM _smithers_runs WHERE run_id='$(sq "$RUN_ID")';")"
  [[ "$FOUND" == "1" ]] || { echo "ERROR: run not found: $RUN_ID" >&2; exit 1; }
fi

NOW_MS=$(date +%s%3N)
SUSPECT_MS=$((SUSPECT_MIN * 60000))
STALE_MS=$((STALE_MIN * 60000))
ABANDON_MS=$((ABANDON_MIN * 60000))

human_age() { # ms -> "Xd HHh MMm", NULL, or clock-skew note
  local ms="$1"
  if [[ "$ms" == "-1" ]]; then echo "NULL (infinitely stale)"; return; fi
  if [[ "$ms" -lt 0 ]]; then echo "in-future (clock skew?)"; return; fi
  local d=$((ms / 86400000)) h=$(( (ms % 86400000) / 3600000 )) m=$(( (ms % 3600000) / 60000 ))
  printf '%dd %02dh %02dm' "$d" "$h" "$m"
}

echo "reconcile-resume $RECONCILER_VERSION — REPORT ONLY (writes nothing)"
echo "db (live, copied): $DB_PATH"
echo "db copy: $COPY (journal_mode=$JM, quick_check=$QC)"
echo "now: $(date -u +%Y-%m-%dT%H:%M:%SZ)  rungs: suspect>${SUSPECT_MIN}m stale>${STALE_MIN}m abandon>=${ABANDON_MIN}m"

# --- 2+3. Sweeps: classify every non-terminal attempt (design §3.1 steps 2-3). ---
# TSV: run_id node_id iter attempt state hb_ms age_ms rstatus class tags
DIVERGENT="$TMPDIR/divergent.tsv"
: > "$DIVERGENT"
while IFS='|' read -r run_id node_id iter attempt state hb_ms rstatus; do
  [[ -n "$run_id" ]] || continue
  [[ -n "$RUN_ID" && "$run_id" != "$RUN_ID" ]] && continue
  case " $ATTEMPT_TERMINAL " in *" $state "*) continue ;; esac  # terminal attempt: ok
  tags=""
  case " $state " in *" in-progress "*) ;; *) tags="${tags}unknown-state-value ";; esac
  run_term=0; case " $RUN_TERMINAL " in *" $rstatus "*) run_term=1 ;; esac
  run_missing=0; [[ -z "$rstatus" ]] && { run_missing=1; tags="${tags}1B-run-row-missing "; }
  if [[ -z "$hb_ms" ]]; then age_ms=-1; else age_ms=$((NOW_MS - hb_ms)); fi
  class=""
  if [[ $run_term -eq 1 ]]; then
    tags="${tags}1A-run-terminal/attempt-in-progress "
    if [[ $age_ms -ge 0 && $age_ms -lt $SUSPECT_MS ]]; then
      class="zombie-suspect"   # fresh heartbeat + terminal run: NEVER auto-action
    else
      class="would-abandon"    # accept13 rule: writer provably gone, any age
    fi
  else
    if [[ $age_ms -lt 0 ]]; then
      class="would-abandon"; tags="${tags}heartbeat-NULL "
    elif [[ $age_ms -lt $SUSPECT_MS ]]; then
      continue                 # healthy
    elif [[ $age_ms -lt $STALE_MS ]]; then
      class="suspect"
    elif [[ $age_ms -lt $ABANDON_MS ]]; then
      class="stale"
    else
      class="would-abandon"
    fi
  fi
  printf '%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\n' \
    "$run_id" "$node_id" "$iter" "$attempt" "$state" "$hb_ms" "$age_ms" "$rstatus" "$class" "$tags" >> "$DIVERGENT"
done < <(q "SELECT a.run_id, a.node_id, a.iteration, a.attempt, a.state,
  a.heartbeat_at_ms, r.status
  FROM _smithers_attempts a LEFT JOIN _smithers_runs r ON r.run_id = a.run_id
  ORDER BY a.run_id, a.node_id, a.iteration, a.attempt;")

NDIV="$(wc -l < "$DIVERGENT" | tr -d ' ')"
echo "divergent attempts: $NDIV"

# Stage tables = non-_smithers tables carrying a run_id column (for §1D).
STAGE_TABLES="$TMPDIR/stage_tables.txt"
: > "$STAGE_TABLES"
while IFS='|' read -r t; do
  [[ -n "$t" ]] || continue
  has_runid="$(q "SELECT COUNT(*) FROM pragma_table_info('$(sq "$t")') WHERE name='run_id';")"
  [[ "$has_runid" == "1" ]] && echo "$t" >> "$STAGE_TABLES"
done < <(q "SELECT name FROM sqlite_master WHERE type='table'
  AND name NOT LIKE '\_smithers\_%' ESCAPE '\' AND name <> 'sqlite_sequence' ORDER BY name;")

ANOMALIES=0
rank() { # worst-classification rank for a run
  case "$1" in
    would-abandon) echo 4 ;; zombie-suspect) echo 3 ;; stale) echo 2 ;; suspect) echo 1 ;; *) echo 0 ;;
  esac
}

for run_id in $(cut -d $'\x1f' -f1 "$DIVERGENT" | sort -u); do
  ANOMALIES=1
  # worst classification for this run; also pre-count abandonments for seq numbering
  worst="suspect"; worst_r=0; N_ABANDON=0
  while IFS=$'\x1f' read -r _r _n _i _a _s _hb _age _rs class _tags; do
    r=$(rank "$class"); [[ $r -gt $worst_r ]] && { worst_r=$r; worst="$class"; }
    [[ "$class" == "would-abandon" ]] && N_ABANDON=$((N_ABANDON + 1))
  done < <(awk -F'\x1f' -v rid="$run_id" '$1==rid' "$DIVERGENT")
  ABANDON_SEQ=0  # counts AttemptAbandoned events already numbered for this run
  MAXSEQ="$(q "SELECT COALESCE(MAX(seq),0) FROM _smithers_events WHERE run_id='$(sq "$run_id")';")"
  echo
  echo "== RUN $run_id  classification: $worst =="
  while IFS='|' read -r status fms crq_ms crq_src err_code wf_hash rhb; do
    echo "  run status=$status finished_at_ms=${fms:-NULL} run_heartbeat_utc=${rhb:-none}"
    echo "  cancel_requested_at_ms=${crq_ms:-NULL} cancel_request_source=${crq_src:-NULL}"
    echo "  error_json.code=$err_code"
    echo "  workflow_hash=${wf_hash:-NULL}"
    if [[ "$status" == "cancelled" && -z "$crq_ms" && -z "$crq_src" ]]; then
      echo "  !! §1G cancel-without-cause: status=cancelled with no cancel record, no finish ts, no error"
    fi
    case "$status" in
      finished) want=RunFinished ;; failed) want=RunFailed ;; cancelled) want=RunCancelled ;; *) want="" ;;
    esac
    if [[ -n "$want" ]]; then
      n="$(q "SELECT COUNT(*) FROM _smithers_events WHERE run_id='$(sq "$run_id")' AND type='$want';")"
      [[ "$n" == "0" ]] && echo "  !! §1C run/status without trail evidence: status=$status but no $want event"
    fi
    REPAIR_RUN_FINISH=0
    if [[ -z "$fms" ]]; then
      case " $RUN_TERMINAL " in *" $status "*) REPAIR_RUN_FINISH=1 ;; esac
    fi
  done < <(q "SELECT status, finished_at_ms, cancel_requested_at_ms, cancel_request_source,
    COALESCE(json_extract(error_json,'\$.code'),'none'), workflow_hash,
    CASE WHEN heartbeat_at_ms IS NULL THEN '' ELSE datetime(heartbeat_at_ms/1000,'unixepoch') END
    FROM _smithers_runs WHERE run_id='$(sq "$run_id")';")

  while IFS=$'\x1f' read -r _r node_id iter attempt state hb_ms age_ms _rs class tags; do
    if [[ -z "$hb_ms" ]]; then hb_utc="none"; else hb_utc="$(q "SELECT datetime($hb_ms/1000,'unixepoch');")"; fi
    echo "  attempt node=$node_id iter=$iter attempt=$attempt state=$state"
    echo "    heartbeat: utc=$hb_utc age=$(human_age "$age_ms")"
    echo "    divergence: $tags -> $class"
    # §1C node-level: trail-terminal/column-nonterminal, double-terminal.
    term_evts="$(q "SELECT GROUP_CONCAT(DISTINCT type) FROM _smithers_events
      WHERE run_id='$(sq "$run_id")' AND type IN ('NodeFinished','NodeFailed','NodeCancelled')
      AND json_extract(payload_json,'\$.nodeId')='$(sq "$node_id")';")"
    if [[ -n "$term_evts" ]]; then
      ntypes="$(q "SELECT COUNT(DISTINCT type) FROM _smithers_events
        WHERE run_id='$(sq "$run_id")' AND type IN ('NodeFinished','NodeFailed','NodeCancelled')
        AND json_extract(payload_json,'\$.nodeId')='$(sq "$node_id")';")"
      if [[ "$ntypes" -ge 2 ]]; then
        echo "    !! §1C double-terminal: $term_evts for one attempt — needs human forensics"
      else
        echo "    !! §1C trail-terminal/column-nonterminal: $term_evts in trail but state=$state"
      fi
    fi
    # --- WOULD-WRITE plan (text only, never executed) ---
    if [[ "$class" == "zombie-suspect" ]]; then
      echo "    WOULD WRITE: nothing — zombie-suspect: fresh heartbeat + terminal run."
      echo "      Never auto-actioned; requires human forensics (design §3.1 step 2)."
    else
      if [[ "$class" == "would-abandon" ]]; then
        if [[ "$tags" == *"1A"* ]]; then
          reason="run-terminal + attempt in-progress: writer provably gone (design §3.1 step 2, accept13 rule)"
        else
          reason="heartbeat >24h (or NULL) under non-terminal run (design §3.1 step 3)"
        fi
        ABANDON_SEQ=$((ABANDON_SEQ + 1))
        newseq=$((MAXSEQ + ABANDON_SEQ))
        payload="{\"nodeId\":\"$(sq "$node_id")\",\"iteration\":$iter,\"attempt\":$attempt,\"fromState\":\"$state\",\"reason\":\"$(sq "$reason")\",\"heartbeatAgeMs\":$age_ms,\"decidedBy\":\"reconciler\",\"reconcilerVersion\":\"$RECONCILER_VERSION\"}"
        termerr="{\"code\":\"ABANDONED\",\"message\":\"$(sq "$reason")\",\"decidedBy\":\"reconciler\"}"
        echo "    WOULD WRITE (not written — report-only):"
        echo "      -- [1] append-first: AttemptAbandoned event (history is append-only; Temporal pattern)"
        echo "      INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)"
        echo "      VALUES ('$(sq "$run_id")', $newseq, $NOW_MS, 'AttemptAbandoned', '$payload');"
        echo "      -- [2] state-column cache repair, optimistic-concurrency guard (0 rows = raced, abort loudly)"
        echo "      UPDATE _smithers_attempts SET state='abandoned', finished_at_ms=$NOW_MS, terminal_error='$termerr'"
        echo "      WHERE run_id='$(sq "$run_id")' AND node_id='$(sq "$node_id")' AND iteration=$iter AND attempt=$attempt AND state='$state';"
        echo "      -- APPLY PRECONDITIONS (design §4/§6 Ph2): 'abandoned' in attempt enum +"
        echo "      -- _smithers_attempts.terminal_error column landed; backup triple copied;"
        echo "      -- report-only re-run clean immediately before apply."
      else
        echo "    WOULD WRITE: nothing — $class is flag-only (exit 2, resume refused, no auto-write)."
      fi
    fi
    # --- TicketResume preconditions (design §5) ---
    echo "    TicketResume preconditions:"
    if [[ -n "$term_evts" ]]; then
      echo "      P1 trail-ends-terminal: PASS (trail has: $term_evts)"
    else
      echo "      P1 trail-ends-terminal: FAIL — node '$node_id' trail ends without NodeFinished/NodeFailed/NodeCancelled"
    fi
    echo "      P2 run-reconciled: FAIL — run has divergent attempt(s) (this report)"
    if [[ "$class" == "would-abandon" || "$class" == "zombie-suspect" ]]; then
      echo "      P3 stage-attributable: FAIL — pre-migration: non-terminal attempt exists for ($run_id,$node_id); resume from stage output unverified"
    else
      echo "      P3 stage-attributable: FAIL — attempt non-terminal; stage rows (if any) unattributable pre-migration"
    fi
  done < <(awk -F'\x1f' -v rid="$run_id" '$1==rid' "$DIVERGENT")

  # §1D stage-row orphan info for the run.
  stage_total=0
  while read -r t; do
    n="$(q "SELECT COUNT(*) FROM \"$(sq "$t")\" WHERE run_id='$(sq "$run_id")';" 2>/dev/null || echo 0)"
    [[ "$n" != "0" ]] && { echo "  stage table $t: $n row(s) for this run"; stage_total=$((stage_total + n)); }
  done < "$STAGE_TABLES"
  [[ $stage_total -eq 0 ]] && echo "  stage rows: none for this run (§1D: nothing to orphan)"
  [[ $stage_total -gt 0 ]] && echo "  !! §1D phantom-progress risk: $stage_total stage row(s) pre-migration unattributable — TicketResume must exclude until P3 passes"

  land_n="$(q "SELECT COUNT(*) FROM land WHERE run_id='$(sq "$run_id")';" 2>/dev/null || echo 0)"
  if [[ "$land_n" == "0" ]]; then
    echo "  P4 land-immutability: PASS — no land rows for this run"
  else
    echo "  P4 land-immutability: CONDITIONAL — $land_n land row(s) recorded: resume may verify, NEVER re-land"
  fi
  wf_hash="$(q "SELECT COALESCE(workflow_hash,'NULL') FROM _smithers_runs WHERE run_id='$(sq "$run_id")';")"
  echo "  P5 loop-code-currency: UNKNOWN — workflow_hash=$wf_hash; current loop-code hash not available to the reconciler; operator ack required"
  echo "  P6 branch-exists: UNKNOWN — needs jj bookmark lookup with ticket context (TicketResume layer, not DB reconciliation)"

  if [[ "${REPAIR_RUN_FINISH:-0}" == "1" ]]; then
    # seq comes after this run's AttemptAbandoned events (append order = step 4, then step 6)
    newseq=$((MAXSEQ + N_ABANDON + 1))
    rstatus="$(q "SELECT status FROM _smithers_runs WHERE run_id='$(sq "$run_id")';")"
    rpayload="{\"observedStatus\":\"$rstatus\",\"finishedAtMsWasNull\":true,\"missingCauseNote\":\"cancel-without-cause (§1G)\",\"decidedBy\":\"reconciler\",\"reconcilerVersion\":\"$RECONCILER_VERSION\"}"
    echo "  WOULD WRITE (run finish repair, design §3.1 step 6 — terminal status, finished_at_ms NULL):"
    echo "    INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)"
    echo "    VALUES ('$(sq "$run_id")', $newseq, $NOW_MS, 'RunTerminated', '$rpayload');"
    echo "    UPDATE _smithers_runs SET finished_at_ms=$NOW_MS WHERE run_id='$(sq "$run_id")' AND finished_at_ms IS NULL;"
  fi
done

# ok-run census (informational only)
if [[ -n "$RUN_ID" ]]; then TOTAL_RUNS=1; else TOTAL_RUNS="$(q "SELECT COUNT(*) FROM _smithers_runs;")"; fi
DIV_RUNS="$(cut -d $'\x1f' -f1 "$DIVERGENT" | sort -u | wc -l | tr -d ' ')"
echo
echo "runs examined: $TOTAL_RUNS (divergent: $DIV_RUNS, ok: $((TOTAL_RUNS - DIV_RUNS)))"
echo "all queries ran against the DB copy; the live DB was never opened read-write."

if [[ $ANOMALIES -eq 1 ]]; then
  echo "RESULT: anomalies found (exit 2) — review before resuming; nothing was written."
  exit 2
else
  echo "RESULT: clean (exit 0) — no divergence; nothing was written."
fi
