import { describe, expect, test } from "bun:test";
import { TelemetricOracle, type TelemetryVector } from "../src/telemetricOracle";

describe("TelemetricOracle — Non-Invasive Database & Telemetry Grounding", () => {
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

  test("evaluates context saturation and generative efficiency without keystroke injection", () => {
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
    expect(verdict.observabilitySummary).toContain("Saturation: 89.3%");
    expect(verdict.observabilitySummary).toContain("115.0 tok/s");
  });

  test("inspects workflow.db state safely", () => {
    const state = oracle.inspectWorkflowDb("/non/existent/workflow.db");
    expect(state.dbExists).toBe(false);
    expect(state.maxIterations).toBe(25);
    expect(state.isQuiescent).toBe(false);
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
