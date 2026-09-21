# ALIVE acceptance — accept14-20260921 — PASS

Full end-to-end acceptance of the Super-Ralph Smithers workflow on the
byte-exact prompt "Reply with exactly the five-letter word ALIVE and nothing else."

## Verdict: PASS (all 7 criteria)

| # | Criterion | Evidence |
|---|-----------|----------|
| 1 | stdout exactly `ALIVE` (5 bytes, no newline, no quotes) | `out.bin`: 5 bytes, hex `41 4c 49 56 45` |
| 2 | exit 0 | `exit.code` = `0` |
| 3 | workflow DB terminal success | `_smithers_runs`: `accept14-20260921` → `finished` |
| 4 | final_report + completion_validator records | `final_report.reply` = `ALIVE` (5); `completion_validator.valid` = 1 |
| 5 | route/transport/stdout forensics | nim-proxy `http://127.0.0.1:25193` (1 key, model free); validator summary: "The final reply between the markers is exactly 'ALIVE' (5 byte…)" |
| 6 | committed + pushed ancestry | fix commit `d67a32e` on `toxicwind/super-ralph` main (remote ref verified via `git ls-remote`) |
| 7 | step timeline | `stderr.log`: interpret-config ✓ 3m50s → final-report ✓ 3m45s → completion-validator ✓ 3m46s → Run finished |

## What this run proved (beyond accept12)

Run accept12-20260921 (exit 2, empty stdout) failed for two compounding defects,
fixed in commit `d67a32e`:

1. The exact-reply detector regex only matched the literal phrasing
   "exactly the word X", but the prompt said "exactly the five-letter word
   ALIVE" → deterministic pre-check silently skipped.
2. The zod quote-strip transform in `finalReportOutputSchema` does not
   propagate to the persisted DB row (the orchestrator stores the raw agent
   output), so the validator saw 7-byte `"ALIVE"` and — correctly told quotes
   are literal bytes — judged `valid=false`; the Ralph wrapper
   (`maxIterations=1`, `onMaxReached="fail"`) exited 2.

Fix: shared `src/exactReply.ts` (`detectExactReply` with broadened regex +
idempotent `normalizeReply`). `CompletionValidator` detects the broadened
phrasing, compares the NORMALIZED reply in the pre-check, and embeds the
normalized reply in the validator prompt (it judges what the user actually
sees). The CLI `printFinalReply` uses the same helpers and writes the
normalized reply back to the DB — this run's `final_report` row reads `ALIVE`
(5), proving the consume-side normalization chain end to end.

## Artifacts in this directory

- `PROMPT.md` — the acceptance prompt (byte source)
- `stderr.log` — full step timeline from the CLI (headless)
- `exit.code` — process exit code (`0`)
- `out.bin` — exact stdout bytes (5 bytes: `ALIVE`)
- `ACCEPTANCE.md` — this file

## Reproducing

```sh
set -a; . /home/toxic/.secrets; set +a   # FLOCK_API_KEY + proxy URL travel in process env only
bun --no-install src/cli/index.ts docs/acceptance/accept14-20260921/PROMPT.md \
  --run-id <new-run-id> --skip-questions > out.bin 2> stderr.log; echo $? > exit.code
xxd out.bin   # expect: 00000000: 414c 4956 45   ALIVE
```
