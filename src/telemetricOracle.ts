/**
 * telemetricOracle.ts — Non-Invasive Database & Telemetry Grounding Supervisor for Super Ralph.
 *
 * Core Architecture Principles:
 * 1. Zero Keystroke Injection: No tmux send-keys, no C-c, no prompt contamination.
 * 2. Model Integrity: Anchors to the 114-model Sovereign Router (:25104) without socket overriding.
 * 3. Database Grounding: Real-time observation of .super-ralph/workflow.db SQLite state.
 * 4. Multi-Ticket Awareness: Concurrency drops and latency fluctuations treated as natural barrier syncs.
 */

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

export interface TelemetryVector {
  timestamp: string;
  elapsedSeconds: number;
  tokensIn: number;      // Ingestion mass
  tokensOut: number;     // Generative yield
  tokensContext: number; // Active context horizon
  durationSeconds: number;
  velocityTokPerSec: number;
}

export interface WorkflowDbState {
  dbExists: boolean;
  totalTickets: number;
  completedTickets: number;
  inProgressTickets: number;
  activeConcurrency: number;
  currentIteration: number;
  maxIterations: number;
  isQuiescent: boolean;
  lastStateChange: string | null;
}

export interface NonInvasiveVerdict {
  timestamp: string;
  contextSaturationPct: number;
  generativeEfficiency: number;
  entropyIndex: number;
  velocityTokPerSec: number;
  workflowState: WorkflowDbState | null;
  observabilitySummary: string;
}

export class TelemetricOracle {
  private contextCeiling: number;
  private history: TelemetryVector[] = [];

  constructor(contextCeiling = 300_000) {
    this.contextCeiling = contextCeiling;
  }

  parseHudLine(line: string): TelemetryVector | null {
    const raw = line.trim();
    if (!raw) return null;

    const tsMatch = raw.match(/\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/);
    const deltaMatch = raw.match(/Δ\s*(\d+m)?(\d+s)?/);
    const inMatch = raw.match(/In:\s*([\d.]+)(K|M)?/i);
    const outMatch = raw.match(/Out:\s*([\d.]+)(K|M)?/i);
    const totalMatch = raw.match(/Total:\s*([\d.]+)(K|M)?/i);
    const durationMatch = raw.match(/([\d.]+)s\s*\(/);
    const rateMatch = raw.match(/\(([\d.]+)\/s\)/);

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

  inspectWorkflowDb(dbPath: string): WorkflowDbState {
    if (!existsSync(dbPath)) {
      return {
        dbExists: false,
        totalTickets: 0,
        completedTickets: 0,
        inProgressTickets: 0,
        activeConcurrency: 0,
        currentIteration: 0,
        maxIterations: 25,
        isQuiescent: false,
        lastStateChange: null,
      };
    }

    try {
      const db = new Database(dbPath, { readonly: true });
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableSet: Record<string, true> = {};
      for (const t of tables) tableSet[t.name] = true;

      let total = 0;
      let completed = 0;
      let inProgress = 0;
      let iteration = 0;
      let quiescent = false;

      if (tableSet["nodes"]) {
        const nodeStats = db.query("SELECT status, count(*) as count FROM nodes GROUP BY status").all() as Array<{ status: string; count: number }>;
        for (const row of nodeStats) {
          if (row.status === "completed") completed += row.count;
          if (row.status === "running" || row.status === "in_progress") inProgress += row.count;
          total += row.count;
        }
      }

      if (tableSet["runs"]) {
        const runRow = db.query("SELECT status, iteration FROM runs ORDER BY created_at DESC LIMIT 1").get() as { status?: string; iteration?: number } | null;
        if (runRow) {
          iteration = runRow.iteration ?? 0;
          quiescent = runRow.status === "completed";
        }
      }

      db.close();

      return {
        dbExists: true,
        totalTickets: total,
        completedTickets: completed,
        inProgressTickets: inProgress,
        activeConcurrency: inProgress,
        currentIteration: iteration,
        maxIterations: 25,
        isQuiescent: quiescent,
        lastStateChange: new Date().toISOString(),
      };
    } catch {
      return {
        dbExists: true,
        totalTickets: 0,
        completedTickets: 0,
        inProgressTickets: 0,
        activeConcurrency: 0,
        currentIteration: 0,
        maxIterations: 25,
        isQuiescent: false,
        lastStateChange: null,
      };
    }
  }

  evaluate(vector: TelemetryVector, dbPath?: string): NonInvasiveVerdict {
    const etaGen = vector.tokensIn > 0 ? vector.tokensOut / vector.tokensIn : 1.0;
    const saturation = (vector.tokensContext / this.contextCeiling) * 100;
    const dbState = dbPath ? this.inspectWorkflowDb(dbPath) : null;

    const summary = [
      `[Telemetry EKG] Saturation: ${saturation.toFixed(1)}% (${(vector.tokensContext / 1000).toFixed(0)}K / ${(this.contextCeiling / 1000).toFixed(0)}K)`,
      `Yield: ${(etaGen * 100).toFixed(1)}% | Velocity: ${vector.velocityTokPerSec.toFixed(1)} tok/s`,
      dbState?.dbExists
        ? `Database Grounding: ${dbState.completedTickets}/${dbState.totalTickets} settled | In-flight: ${dbState.activeConcurrency} | Iteration: ${dbState.currentIteration}/${dbState.maxIterations}`
        : "Database Grounding: workflow.db initializing",
    ].join(" · ");

    return {
      timestamp: vector.timestamp,
      contextSaturationPct: Number(saturation.toFixed(2)),
      generativeEfficiency: Number(etaGen.toFixed(4)),
      entropyIndex: Number((saturation * (1 - etaGen)).toFixed(2)),
      velocityTokPerSec: vector.velocityTokPerSec,
      workflowState: dbState,
      observabilitySummary: summary,
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
