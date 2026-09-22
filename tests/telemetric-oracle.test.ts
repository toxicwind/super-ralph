import { describe, expect, test } from "bun:test";
import { TelemetricOracle, type TelemetryVector } from "../src/telemetricOracle";

describe("TelemetricOracle", () => {
  const oracle = new TelemetricOracle(300_000);

  test("parses canonical Sovereign HUD telemetry string accurately", () => {
    const raw = "[2026-09-22 07:43:59] Δ 1m33s | In: 2.9K | Out: 1.1K | Total: 268K | 5.9s (115.0/s)";
    const vec = oracle.parseHudLine(raw);
    expect(vec).not.toBeNull();
    expect(vec?.timestamp).toBe("2026-09-22 07:43:59");
    expect(vec?.elapsedSeconds).toBe(93);
    expect(vec?.tokensIn).toBe(2900);
    expect(vec?.tokensOut).toBe(1100);
    expect(vec?.tokensContext).toBe(268000);
    expect(vec?.durationSeconds).toBe(5.9);
    expect(vec?.velocityTokPerSec).toBe(115.0);
  });

  test("evaluates context saturation and generative efficiency on deep context turn", () => {
    const vec: TelemetryVector = {
      timestamp: "2026-09-22 07:43:59",
      elapsedSeconds: 93,
      tokensIn: 2900,
      tokensOut: 1100,
      tokensContext: 268000,
      durationSeconds: 5.9,
      velocityTokPerSec: 115.0,
    };
    const verdict = oracle.evaluate(vec);
    expect(verdict.contextSaturationPct).toBeCloseTo(89.33, 1);
    expect(verdict.generativeEfficiency).toBeCloseTo(0.3793, 2);
    expect(verdict.state).toBe("SATURATED");
    expect(verdict.urgentAction).toBe("SCHEDULE_CONTEXT_CHECKPOINT");
    expect(verdict.advisoryMessage).toContain("Context saturation");
  });

  test("triggers THRASHING state when context is near ceiling with sub-minimal output", () => {
    const vec: TelemetryVector = {
      timestamp: "2026-09-22 07:50:00",
      elapsedSeconds: 240,
      tokensIn: 8500,
      tokensOut: 60, // Minimal yield (inspect loop)
      tokensContext: 285000, // 95% saturation
      durationSeconds: 8.2,
      velocityTokPerSec: 7.3,
    };
    const verdict = oracle.evaluate(vec);
    expect(verdict.state).toBe("THRASHING");
    expect(verdict.generativeEfficiency).toBeLessThan(0.01);
    expect(verdict.urgentAction).toBe("EMERGENCY_COMPACT_AND_EVICT");
    expect(verdict.advisoryMessage).toContain("[ORACLE CRITICAL]");
  });

  test("classifies nominal healthy execution", () => {
    const vec: TelemetryVector = {
      timestamp: "2026-09-22 07:10:00",
      elapsedSeconds: 15,
      tokensIn: 1200,
      tokensOut: 800,
      tokensContext: 15000,
      durationSeconds: 3.2,
      velocityTokPerSec: 120.0,
    };
    const verdict = oracle.evaluate(vec);
    expect(verdict.state).toBe("NOMINAL");
    expect(verdict.urgentAction).toBeNull();
    expect(verdict.contextSaturationPct).toBe(5.0);
  });

  test("formats vector back to standard HUD format", () => {
    const vec: TelemetryVector = {
      timestamp: "2026-09-22 07:43:59",
      elapsedSeconds: 93,
      tokensIn: 2900,
      tokensOut: 1100,
      tokensContext: 268000,
      durationSeconds: 5.9,
      velocityTokPerSec: 115.0,
    };
    const formatted = oracle.formatHud(vec);
    expect(formatted).toBe("[2026-09-22 07:43:59] Δ 1m33s | In: 2.9K | Out: 1.1K | Total: 268.0K | 5.9s (115.0/s)");
  });
});
