/**
 * nimProxy — flock integration for super-ralph (nim-proxy absorbed by flock 2026-09-17).
 *
 * Routes every model call through the local flock proxy (default
 * http://127.0.0.1:25193) instead of direct provider APIs:
 *
 * - `resolveProxyConfig()` reads FLOCK_API_KEY (comma-separated for
 *   multi-key rotation), falling back to NIM_PROXY_API_KEY (deprecated alias), then ANTHROPIC_API_KEY / NVIDIA_API_KEY.
 *   Throws NimProxyConfigError with an actionable message when no key is set.
 * - `proxyEnvOverrides()` builds the env overrides (NIM_BASE_URL,
 *   ANTHROPIC_BASE_URL, NVIDIA_API_KEY, NIM_MODEL) that make the `claude`
 *   NIM shim — and therefore every smithers-spawned agent — talk to the
 *   proxy. Keys travel in child-process env only; never written to files.
 * - `NimProxyKeyPool` lifts the AgentRegistry rate-limit pattern
 *   (rateLimitedUntil / isAvailable / recordRateLimit) for 429/backoff
 *   handling across keys.
 * - `proxyChatCompletions()` performs OpenAI-compatible chat completions
 *   against the proxy with per-key rotation on 429s.
 *
 * Escape hatch: FLOCK_BYPASS=1 (or NIM_PROXY_BYPASS=1) restores the pre-proxy direct behavior.
 *
 * Security: key values are NEVER logged, printed, or written to files.
 * Stats and errors use opaque "key#N" labels only.
 */

const DEFAULT_ROUTER_PORT = process.env.SOVEREIGN_ROUTER_PORT || "25104";
export const DEFAULT_PROXY_BASE_URL =
  process.env.SOVEREIGN_ROUTER_URL ||
  process.env.FLOCK_BASE_URL ||
  `http://127.0.0.1:${DEFAULT_ROUTER_PORT}`;
export const DEFAULT_PROXY_MODEL = "free";
const DEFAULT_RETRY_AFTER_MS = 60_000;

export class NimProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimProxyConfigError";
  }
}

export function isProxyBypassed(): boolean {
  return process.env.FLOCK_BYPASS === "1" || process.env.NIM_PROXY_BYPASS === "1";
}

/**
 * Resolve the proxy API key. Never logs the value.
 * Throws NimProxyConfigError with an actionable message when unset.
 */
export function resolveProxyApiKey(): string {
  const key =
    process.env.FLOCK_API_KEY ||
    process.env.NIM_PROXY_API_KEY || // deprecated compat alias
    process.env.ANTHROPIC_API_KEY ||
    process.env.NVIDIA_API_KEY;
  if (!key || !key.trim()) {
    throw new NimProxyConfigError(
      "flock: no API key found. Set FLOCK_API_KEY to your flock client " +
        "key (comma-separated for multi-key rotation; NIM_PROXY_API_KEY still accepted as a deprecated alias), or set FLOCK_BYPASS=1 " +
        "to use the previous direct-provider behavior."
    );
  }
  return key.trim();
}

export type ProxyConfig = {
  baseUrl: string;
  apiKeys: string[];
  model: string;
  bypass: boolean;
};

export function resolveProxyConfig(): ProxyConfig {
  if (isProxyBypassed()) {
    return { baseUrl: "", apiKeys: [], model: "", bypass: true };
  }
  const apiKeys = resolveProxyApiKey()
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    throw new NimProxyConfigError(
      "flock: FLOCK_API_KEY contained no usable keys."
    );
  }
  const baseUrl = (
    process.env.FLOCK_BASE_URL || process.env.NIM_PROXY_BASE_URL || DEFAULT_PROXY_BASE_URL
  ).replace(/\/+$/, "").replace(/\/v1$/, "");
  const model = process.env.FLOCK_MODEL || process.env.NIM_PROXY_MODEL || DEFAULT_PROXY_MODEL;
  return { baseUrl, apiKeys, model, bypass: false };
}

/**
 * Env overrides that route the `claude` NIM shim (which reads NIM_BASE_URL +
 * NVIDIA_API_KEY) and any ANTHROPIC_BASE_URL-aware client through the proxy.
 * Merge into a child process env — never persist to files. Note: smithers'
 * ClaudeCodeAgent blanks ANTHROPIC_API_KEY on spawn but passes through
 * NVIDIA_API_KEY / NIM_BASE_URL untouched, so these survive to the shim.
 */
export function proxyEnvOverrides(
  config: ProxyConfig
): Record<string, string> {
  if (config.bypass || config.apiKeys.length === 0) return {};
  // The claude NIM shim fetches NIM_BASE_URL + "/chat/completions", so the
  // /v1 prefix must be part of NIM_BASE_URL itself. resolveProxyConfig
  // canonicalizes baseUrl to the bare origin (trailing /v1 stripped).
  return {
    ANTHROPIC_BASE_URL: config.baseUrl,
    NIM_BASE_URL: config.baseUrl + "/v1",
    NVIDIA_API_KEY: config.apiKeys[0],
    NIM_MODEL: config.model,
  };
}

export type ProxyKeyStats = {
  /** Opaque label ("key#1") — never the key value. */
  label: string;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  rateLimitedUntil: number | null;
  isRateLimited: boolean;
  isAvailable: boolean;
  lastFailureReason: string | null;
};

type KeyState = {
  key: string;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  rateLimitedUntil: number | null;
  lastFailureReason: string | null;
};

/**
 * Multi-key pool with AgentRegistry-style rate-limit tracking.
 * Keys are deduplicated on registration; rotation is round-robin over
 * keys whose rate limit has expired.
 */
export class NimProxyKeyPool {
  private keys: KeyState[] = [];
  private cursor = 0;

  constructor(keys: string[]) {
    const seen = new Set<string>();
    for (const raw of keys) {
      const key = raw.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.keys.push({
        key,
        successCount: 0,
        failureCount: 0,
        rateLimitCount: 0,
        rateLimitedUntil: null,
        lastFailureReason: null,
      });
    }
  }

  get size(): number {
    return this.keys.length;
  }

  private isLimited(state: KeyState, now: number): boolean {
    return state.rateLimitedUntil !== null && state.rateLimitedUntil > now;
  }

  /** Next available key (round-robin), or null when all are rate-limited. */
  nextAvailable(): string | null {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      if (!this.isLimited(this.keys[idx], now)) {
        this.cursor = (idx + 1) % this.keys.length;
        return this.keys[idx].key;
      }
    }
    return null;
  }

  recordSuccess(key: string): void {
    const s = this.keys.find((k) => k.key === key);
    if (!s) return;
    s.successCount++;
    s.rateLimitedUntil = null;
    s.lastFailureReason = null;
  }

  recordFailure(key: string, reason: string): void {
    const s = this.keys.find((k) => k.key === key);
    if (!s) return;
    s.failureCount++;
    s.lastFailureReason = reason;
  }

  recordRateLimit(key: string, retryAfterMs?: number): void {
    const s = this.keys.find((k) => k.key === key);
    if (!s) return;
    s.rateLimitCount++;
    s.lastFailureReason = "Rate limited (429)";
    s.rateLimitedUntil = Date.now() + (retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
  }

  /** Earliest ms-epoch at which a rate-limited key becomes usable, or null. */
  earliestRetryAt(): number | null {
    const times = this.keys
      .map((k) => k.rateLimitedUntil)
      .filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }

  getStats(): ProxyKeyStats[] {
    const now = Date.now();
    return this.keys.map((s, i) => {
      const limited = this.isLimited(s, now);
      return {
        label: "key#" + (i + 1),
        successCount: s.successCount,
        failureCount: s.failureCount,
        rateLimitCount: s.rateLimitCount,
        rateLimitedUntil: s.rateLimitedUntil,
        isRateLimited: limited,
        isAvailable: !limited,
        lastFailureReason: s.lastFailureReason,
      };
    });
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfterMs(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return DEFAULT_RETRY_AFTER_MS;
}

export type ProxyChatOptions = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  config?: ProxyConfig;
};

/**
 * OpenAI-compatible chat completions through the flock proxy with per-key
 * rotation on 429s. Throws a descriptive error (no key material) when all
 * keys are exhausted or rate-limited.
 */
export async function proxyChatCompletions(
  opts: ProxyChatOptions
): Promise<string> {
  const config = opts.config ?? resolveProxyConfig();
  if (config.bypass) {
    throw new NimProxyConfigError(
      "flock: proxyChatCompletions called while FLOCK_BYPASS=1."
    );
  }
  const pool = new NimProxyKeyPool(config.apiKeys);
  const url = config.baseUrl + "/v1/chat/completions";
  const model = opts.model || config.model;
  const messages: { role: string; content: string }[] = [];
  if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
  messages.push({ role: "user", content: opts.prompt });

  let lastError: Error | null = null;
  const attempts = pool.size;
  for (let i = 0; i < attempts; i++) {
    const key = pool.nextAvailable();
    if (!key) break;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 4096,
          temperature: opts.temperature ?? 1.0,
          messages,
        }),
      });
      if (resp.status === 429) {
        pool.recordRateLimit(key, parseRetryAfterMs(resp.headers.get("retry-after")));
        lastError = new Error("nim-proxy rate limited (HTTP 429); rotating key");
        continue;
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error("nim-proxy HTTP " + resp.status + ": " + body.slice(0, 300));
      }
      const data = (await resp.json()) as any;
      const text: string = data?.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("nim-proxy returned an empty completion");
      pool.recordSuccess(key);
      return text;
    } catch (err: any) {
      pool.recordFailure(key, String(err?.message ?? err).slice(0, 120));
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const retryAt = pool.earliestRetryAt();
  const retryHint = retryAt
    ? " Earliest retry at " + new Date(retryAt).toISOString() + "."
    : "";
  throw new Error(
    "nim-proxy: all " +
      pool.size +
      " key(s) exhausted or rate-limited." +
      retryHint +
      (lastError ? " Last error: " + lastError.message : "")
  );
}
