# Pre-loop environment audit — super-ralph outer loop

**Purpose:** prevent env-var poisoning (cf. `NIM_MODEL=moonshotai/kimi-k3` stale-inheritance incident,
fixed in `20f0994`). Run these checks — manually or scripted — **before** starting the outer Ralph
loop. Failures are t=0 gates: fix the environment, do not start the loop.

## Checklist

1. **Resolve the model alias.** Run the same resolution `src/nimProxy.ts#resolveProxyConfig()` performs:
   `FLOCK_MODEL` → `NIM_PROXY_MODEL` → `"free"` (default). Record the resolved value in the run log.
2. **Reject stale inherited model names.** `NIM_MODEL` must not name a decommissioned/unknown model.
   If `NIM_MODEL` is set but `FLOCK_MODEL`/`NIM_PROXY_MODEL` are not, that is a red flag — the loop
   would inherit a possibly-stale alias instead of the live resolver.
3. **Bypass flags are intentional.** `FLOCK_BYPASS=1` / `NIM_PROXY_BYPASS=1` restores direct-provider
   behavior. If set, confirm it is deliberate (documented reason), not leftover from debugging.
4. **Keys present, values never logged.** `FLOCK_API_KEY` (or deprecated `NIM_PROXY_API_KEY`, or
   `ANTHROPIC_API_KEY`/`NVIDIA_API_KEY` fallback) must be set; `resolveProxyApiKey()` throws
   `NimProxyConfigError` otherwise. Never print key values — use opaque `key#N` labels only.
5. **Pin for the run (continuation inheritance).** The model alias resolved at loop start is the one
   every subagent spawn must use for the whole run. Do not re-resolve mid-loop; if the environment
   changes under a running loop, that is semantic drift (see BEGIN AI TRANSACTION anomalies:
   semantic read skew / compatibility skew) — stop the loop and restart with a fresh audit.

## Quick audit command (run from the repo root)

```bash
echo "FLOCK_MODEL=${FLOCK_MODEL:-<unset>}"
echo "NIM_PROXY_MODEL=${NIM_PROXY_MODEL:-<unset>}"
echo "NIM_MODEL=${NIM_MODEL:-<unset>}"
echo "FLOCK_BYPASS=${FLOCK_BYPASS:-0} NIM_PROXY_BYPASS=${NIM_PROXY_BYPASS:-0}"
for v in FLOCK_API_KEY NIM_PROXY_API_KEY ANTHROPIC_API_KEY NVIDIA_API_KEY; do
  if [ -n "${!v:-}" ]; then echo "$v=set (value hidden)"; else echo "$v=<unset>"; fi
done
```

Reference: `src/nimProxy.ts` (`resolveProxyConfig`, `proxyEnvOverrides`), paper
"BEGIN AI TRANSACTION: Semantic Isolation for Durable AI Workflows" (Mozafari, 2026).
