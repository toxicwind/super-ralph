/**
 * telemetricOracle.ts — In-Loop & Out-of-Band Cognitive EKG Supervisor for Super Ralph.
 *
 * Mathematical modeling of runtime thermodynamics:
 * - Context Boundary Saturation (S_ctx)
 * - Generative Efficiency Ratio (\eta_gen)
 * - Cognitive Entropy Density (H_cog)
 * - Dynamic Expected Value & Deliberation Lock Guard
 */

export interface TelemetryVector {
  timestamp: string;
  elapsedSeconds: number;
  tokensIn: number;      // Drop count / Ingestion mass
  tokensOut: number;     // Leave count / Generative yield
  tokensContext: number; // Active context horizon
  durationSeconds: number;
  velocityTokPerSec: number;
}

export type CognitiveState = "NOMINAL" | "SATURATED" | "THRASHING" | "STALLED";

export interface OracleVerdict {
  state: CognitiveState;
  generativeEfficiency: number; // tokensOut / tokensIn
  contextSaturationPct: number; // tokensContext / contextCeiling
  entropyIndex: number;
  thrashProbability: number;
  urgentAction: string | null;
  advisoryMessage: string | null;
}

export class TelemetricOracle {
  private contextCeiling: number;
  private history: TelemetryVector[] = [];

  constructor(contextCeiling = 300_000) {
    this.contextCeiling = contextCeiling;
  }

  /**
   * Parse a raw terminal HUD telemetry line.
   */
  parseHudLine(line: string): TelemetryVector | null {
    const raw = line.trim();
    if (!raw) return null;

    const tsMatch = raw.match(/\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/);
    const deltaMatch = raw.match(/Δ\s*(\d+m)?(\d+s)?/);
    const inMatch = raw.match(/In:\s*([\d\.]+)(K|M)?/i);
    const outMatch = raw.match(/Out:\s*([\d\.]+)(K|M)?/i);
    const totalMatch = raw.match(/Total:\s*([\d\.]+)(K|M)?/i);
    const durationMatch = raw.match(/([\d\.]+)s\s*\(/);
    const rateMatch = raw.match(/\(([\d\.]+)\/s\)/);

    if (!tsMatch) return null;

    const parseNum = (val: string | undefined, mult: string | undefined): number => {
      if (!val) return 0;
      const num = parseFloat(val);
      if (mult?.toUpperCase() === "K") return num * 1000;
      if (mult?.toUpperCase() === "M") return num * 1000000;
      return num;
    };

    let elapsed = 0;
    if (deltaMatch) {
      const m = deltaMatch[1] ? parseInt(deltaMatch[1]) : 0;
      const s = deltaMatch[2] ? parseInt(deltaMatch[2]) : 0;
      elapsed = m * 60 + s;
    }

    const vector: TelemetryVector = {
      timestamp: tsMatch[1],
      elapsedSeconds: elapsed,
      tokensIn: parseNum(inMatch?.[1], inMatch?.[2]),
      tokensOut: parseNum(outMatch?.[1], outMatch?.[2]),
      tokensContext: parseNum(totalMatch?.[1], totalMatch?.[2]),
      durationSeconds: durationMatch ? parseFloat(durationMatch[1]) : 0,
      velocityTokPerSec: rateMatch ? parseFloat(rateMatch[1]) : 0,
    };

    this.record(vector);
    return vector;
  }

  record(vector: TelemetryVector): void {
    this.history.push(vector);
    if (this.history.length > 50) this.history.shift();
  }

  /**
   * Evaluate a turn vector programmatically.
   */
  evaluateTurn(
    tokensIn: number,
    tokensOut: number,
    tokensContext: number,
    durationSeconds = 1.0,
    velocityTokPerSec = 0
  ): OracleVerdict {
    const v: TelemetryVector = {
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
      elapsedSeconds: 0,
      tokensIn,
      tokensOut,
      tokensContext,
      durationSeconds,
      velocityTokPerSec: velocityTokPerSec || (durationSeconds > 0 ? tokensOut / durationSeconds : 0),
    };
    return this.evaluate(v);
  }

  /**
   * Evaluates cognitive health via Bayesian state transitions.
   */
  evaluate(vector: TelemetryVector): OracleVerdict {
    const etaGen = vector.tokensIn > 0 ? vector.tokensOut / vector.tokensIn : 1.0;
    const saturation = (vector.tokensContext / this.contextCeiling) * 100;
    
    let thrashScore = 0;
    if (saturation > 85) thrashScore += 0.4;
    if (etaGen < 0.1) thrashScore += 0.35;
    if (vector.durationSeconds > 10 && vector.velocityTokPerSec < 20) thrashScore += 0.25;
    const pThrash = Math.min(1.0, Math.max(0.0, thrashScore));

    let state: CognitiveState = "NOMINAL";
    let action: string | null = null;
    let advisory: string | null = null;

    if (pThrash >= 0.75 || (saturation >= 88 && etaGen < 0.2)) {
      state = "THRASHING";
      action = "EMERGENCY_COMPACT_AND_EVICT";
      advisory = `[ORACLE CRITICAL] Attention saturation ${saturation.toFixed(1)}% breached with low yield (${(etaGen * 100).toFixed(1)}%). State eviction required.`;
    } else if (saturation >= 80) {
      state = "SATURATED";
      action = "SCHEDULE_CONTEXT_CHECKPOINT";
      advisory = `[ORACLE ADVISORY] Context saturation at ${saturation.toFixed(1)}%. Checkpoint state before next iteration.`;
    } else if (vector.velocityTokPerSec < 5 && vector.durationSeconds > 15) {
      state = "STALLED";
      action = "ROUTE_SHIFT_LLAMA_SWAP";
      advisory = `[ORACLE WARN] Token throughput stalled (${vector.velocityTokPerSec.toFixed(1)} tok/s). Recommend shifting route to local herd :25100.`;
    }

    return {
      state,
      generativeEfficiency: Number(etaGen.toFixed(4)),
      contextSaturationPct: Number(saturation.toFixed(2)),
      entropyIndex: Number((saturation * (1 - etaGen)).toFixed(2)),
      thrashProbability: Number(pThrash.toFixed(2)),
      urgentAction: action,
      advisoryMessage: advisory,
    };
  }

  formatHud(vector: TelemetryVector): string {
    const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
    const m = Math.floor(vector.elapsedSeconds / 60);
    const s = vector.elapsedSeconds % 60;
    const deltaStr = m > 0 ? `${m}m${s}s` : `${s}s`;
    return `[${vector.timestamp}] Δ ${deltaStr} | In: ${formatK(vector.tokensIn)} | Out: ${formatK(vector.tokensOut)} | Total: ${formatK(vector.tokensContext)} | ${vector.durationSeconds.toFixed(1)}s (${vector.velocityTokPerSec.toFixed(1)}/s)`;
  }
}
