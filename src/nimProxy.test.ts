/**
 * Unit tests for src/nimProxy.ts — no network calls; fetch is mocked.
 * Run: bun test src/nimProxy.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  NimProxyKeyPool,
  resolveProxyConfig,
  resolveProxyApiKey,
  proxyEnvOverrides,
  proxyChatCompletions,
  isProxyBypassed,
  parseRetryAfterMs,
  NimProxyConfigError,
  DEFAULT_PROXY_BASE_URL,
  type ProxyConfig,
} from "./nimProxy.ts";

const ENV_KEYS = [
  "FLOCK_API_KEY",
  "FLOCK_BASE_URL",
  "FLOCK_MODEL",
  "FLOCK_BYPASS",
  "NIM_PROXY_API_KEY",
  "ANTHROPIC_API_KEY",
  "NVIDIA_API_KEY",
  "NIM_PROXY_BASE_URL",
  "NIM_PROXY_MODEL",
  "NIM_PROXY_BYPASS",
];

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedFetch) globalThis.fetch = savedFetch;
});

function fakeConfig(keys: string[] = ["npk_test_1", "npk_test_2"]): ProxyConfig {
  return { baseUrl: "http://127.0.0.1:8000", apiKeys: keys, model: "openai/gpt-oss-20b", bypass: false };
}

function okResponse(text: string) {
  return {
    status: 200,
    ok: true,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content: text } }] }),
    text: async () => text,
  } as unknown as Response;
}

describe("key resolution", () => {
  test("throws actionable NimProxyConfigError when no key is set", () => {
    let err: unknown;
    try {
      resolveProxyApiKey();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimProxyConfigError);
    expect((err as Error).message).toContain("FLOCK_API_KEY");
    expect((err as Error).message).toContain("FLOCK_BYPASS=1");
  });

  test("prefers FLOCK_API_KEY over NIM_PROXY_API_KEY", () => {
    process.env.NVIDIA_API_KEY = "nvapi-should-lose";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-lose";
    process.env.FLOCK_API_KEY = "flock-wins";
    process.env.NIM_PROXY_API_KEY = "npk-loses";
    expect(resolveProxyApiKey()).toBe("flock-wins");
  });

  test("falls back to NVIDIA_API_KEY", () => {
    process.env.NVIDIA_API_KEY = "nvapi-fallback";
    expect(resolveProxyApiKey()).toBe("nvapi-fallback");
  });

  test("splits comma-separated keys and trims", () => {
    process.env.NIM_PROXY_API_KEY = " npk-a , npk-b ,, npk-a ";
    const cfg = resolveProxyConfig();
    expect(cfg.apiKeys).toEqual(["npk-a", "npk-b", "npk-a"]);
    expect(cfg.baseUrl).toBe(DEFAULT_PROXY_BASE_URL);
    expect(cfg.bypass).toBe(false);
  });

  test("honors FLOCK_BASE_URL and FLOCK_MODEL overrides (NIM_PROXY_* as fallback)", () => {
    process.env.NIM_PROXY_API_KEY = "npk-x";
    process.env.NIM_PROXY_BASE_URL = "http://proxy.local:9000/";
    process.env.NIM_PROXY_MODEL = "custom/model";
    const cfg = resolveProxyConfig();
    expect(cfg.baseUrl).toBe("http://proxy.local:9000");
    expect(cfg.model).toBe("custom/model");
  });
});

describe("bypass", () => {
  test("isProxyBypassed only on exactly '1'", () => {
    expect(isProxyBypassed()).toBe(false);
    process.env.NIM_PROXY_BYPASS = "true";
    expect(isProxyBypassed()).toBe(false);
    process.env.NIM_PROXY_BYPASS = "1";
    expect(isProxyBypassed()).toBe(true);
  });

  test("resolveProxyConfig returns bypass config", () => {
    process.env.NIM_PROXY_BYPASS = "1";
    const cfg = resolveProxyConfig();
    expect(cfg.bypass).toBe(true);
    expect(proxyEnvOverrides(cfg)).toEqual({});
  });
});

describe("proxyEnvOverrides", () => {
  test("sets shim-compatible env vars", () => {
    const env = proxyEnvOverrides(fakeConfig(["npk-primary"]));
    expect(env.NIM_BASE_URL).toBe("http://127.0.0.1:8000/v1");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8000");
    expect(env.NVIDIA_API_KEY).toBe("npk-primary");
    expect(env.NIM_MODEL).toBe("openai/gpt-oss-20b");
  });

  test("canonicalizes a trailing /v1 in NIM_PROXY_BASE_URL", () => {
    process.env.NIM_PROXY_API_KEY = "npk-primary";
    process.env.NIM_PROXY_BASE_URL = "http://proxy.local:9000/v1/";
    const cfg = resolveProxyConfig();
    expect(cfg.baseUrl).toBe("http://proxy.local:9000");
    const env = proxyEnvOverrides(cfg);
    expect(env.NIM_BASE_URL).toBe("http://proxy.local:9000/v1");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy.local:9000");
  });
});

describe("NimProxyKeyPool", () => {
  test("round-robins across keys", () => {
    const pool = new NimProxyKeyPool(["a", "b"]);
    expect(pool.nextAvailable()).toBe("a");
    expect(pool.nextAvailable()).toBe("b");
    expect(pool.nextAvailable()).toBe("a");
  });

  test("dedupes keys", () => {
    const pool = new NimProxyKeyPool(["a", "a", "b"]);
    expect(pool.size).toBe(2);
  });

  test("skips rate-limited keys until expiry", () => {
    const pool = new NimProxyKeyPool(["a", "b"]);
    pool.recordRateLimit("a", 60_000);
    expect(pool.nextAvailable()).toBe("b");
    expect(pool.nextAvailable()).toBe("b");
    const stats = pool.getStats();
    expect(stats[0].isRateLimited).toBe(true);
    expect(stats[0].isAvailable).toBe(false);
    expect(stats[0].rateLimitCount).toBe(1);
    expect(stats[1].isAvailable).toBe(true);
  });

  test("returns null when all keys are limited; earliestRetryAt set", () => {
    const pool = new NimProxyKeyPool(["a", "b"]);
    pool.recordRateLimit("a", 60_000);
    pool.recordRateLimit("b", 30_000);
    expect(pool.nextAvailable()).toBeNull();
    const retryAt = pool.earliestRetryAt();
    expect(retryAt).not.toBeNull();
    expect(retryAt as number).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  test("success clears a stale rate limit", () => {
    const pool = new NimProxyKeyPool(["a"]);
    pool.recordRateLimit("a", 60_000);
    expect(pool.nextAvailable()).toBeNull();
    pool.recordSuccess("a");
    expect(pool.nextAvailable()).toBe("a");
  });

  test("stats never expose key values", () => {
    const pool = new NimProxyKeyPool(["npk-super-secret-value"]);
    pool.recordFailure("npk-super-secret-value", "boom");
    const blob = JSON.stringify(pool.getStats());
    expect(blob).not.toContain("npk-super-secret-value");
    expect(blob).toContain("key#1");
  });
});

describe("parseRetryAfterMs", () => {
  test("parses seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });
  test("defaults on null/garbage", () => {
    expect(parseRetryAfterMs(null)).toBe(60_000);
    expect(parseRetryAfterMs("soon")).toBe(60_000);
  });
});

describe("proxyChatCompletions", () => {
  test("rotates to next key on 429 then succeeds", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const auth = init.headers.Authorization as string;
      seen.push(auth);
      if (seen.length === 1) {
        return {
          status: 429,
          ok: false,
          headers: new Headers({ "retry-after": "5" }),
          text: async () => "rate limited",
        } as unknown as Response;
      }
      return okResponse("hello from key two");
    }) as typeof fetch;

    const text = await proxyChatCompletions({ prompt: "hi", config: fakeConfig() });
    expect(text).toBe("hello from key two");
    expect(seen).toEqual(["Bearer npk_test_1", "Bearer npk_test_2"]);
    expect(seen[0]).not.toContain("npk_test_2");
  });

  test("throws exhausted error when all keys 429", async () => {
    globalThis.fetch = (async () => ({
      status: 429,
      ok: false,
      headers: new Headers({ "retry-after": "30" }),
      text: async () => "limited",
    })) as unknown as typeof fetch;

    let err: unknown;
    try {
      await proxyChatCompletions({ prompt: "hi", config: fakeConfig(["k1"]) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("exhausted or rate-limited");
    expect((err as Error).message).not.toContain("k1");
  });

  test("throws on HTTP 500 with status in message", async () => {
    globalThis.fetch = (async () => ({
      status: 500,
      ok: false,
      headers: new Headers(),
      text: async () => "proxy exploded",
    })) as unknown as typeof fetch;

    await expect(
      proxyChatCompletions({ prompt: "hi", config: fakeConfig(["k1"]) })
    ).rejects.toThrow("nim-proxy HTTP 500");
  });

  test("refuses to run in bypass mode", async () => {
    await expect(
      proxyChatCompletions({
        prompt: "hi",
        config: { baseUrl: "", apiKeys: [], model: "", bypass: true },
      })
    ).rejects.toBeInstanceOf(NimProxyConfigError);
  });
});
