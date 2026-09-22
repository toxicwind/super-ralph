# Sovereign Corral (`corral` / `ralph`) — Multi-Agent Engineering Engine

[![Package](https://img.shields.io/badge/package-@sovereign/corral-orange?logo=npm)](package.json)
[![Bun](https://img.shields.io/badge/runtime-Bun%20v1.4.2-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org)
[![Smithers](https://img.shields.io/badge/orchestrator-Smithers%200.32.0-purple)](https://smithers.sh)
[![Tests](https://img.shields.io/badge/tests-46%20PASS%20%C2%B7%200%20FAIL-success)](tests/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Sovereign Corral** (formerly *super-ralph*) is the ticket enclosure & multi-agent engineering engine for the Sovereign estate — orchestrating task graphs on [Smithers](https://smithers.sh) with a single-outer-loop finite convergence guarantee, speculative Jujutsu/Git merge queues, non-invasive SQLite database grounding, and Telemetric Cognitive EKG runtime supervision.

---

## 1. System Architecture

```mermaid
flowchart TD
    Prompt[User Prompt / Specification] --> Clarify[ClarifyingQuestions UI]
    Clarify --> PlanPass[InterpretConfig Planning Pass]
    PlanPass --> Gen[Generate .super-ralph/workflow.tsx]
    
    subgraph CorralLoop["Corral Loop (Finite Convergence)"]
        direction TB
        Sched[TicketScheduler: Priority Queue & Capacity] --> Exec[Parallel Worktree Execution]
        
        subgraph StagePipeline["Per-Ticket 5-Stage Pipeline"]
            Research[1. Research] --> Plan[2. Plan]
            Plan --> Implement[3. Implement]
            Implement --> Test[4. Test & Build Verify]
            Test --> Review[5. Spec & Code Review]
        end
        
        Exec --> StagePipeline
        StagePipeline --> MergeQ[AgenticMergeQueue: Speculative CI & Landing]
    end
    
    Gen --> CorralLoop
    MergeQ --> Done{allWorkComplete?}
    Done -- No --> Sched
    Done -- Yes --> Settled[Clean Terminal State / Work Landed]
```

---

## 2. Provenance & Evolutionary Divergence

Sovereign Corral began as a fork of [roninjin10/super-ralph](https://github.com/roninjin10/super-ralph) (William Cory) and [evmts/super-ralph](https://github.com/evmts/super-ralph), but has completely diverged into an emergent sovereign orchestration layer:

| Architectural Component | Upstream `super-ralph` | Sovereign `corral` |
|---|---|---|
| **Loop Topology** | 3 independent sibling loops (starvation/deadlock prone) | **Single unified outer Ralph loop** containing schedule $\to$ execute $\to$ merge with live `allWorkComplete` quiescence. |
| **Model Routing** | Direct cloud API calls with hardcoded provider keys | **Sovereign Router (`:25104`) integration** with 114 curated models, ELO balancing, and keyless local fallback. |
| **Runtime Supervision** | None / manual terminal tracking | **Telemetric Cognitive EKG (`telemetricOracle.ts`)** with non-invasive SQLite state grounding. |
| **Workspace Merge** | Basic sequential merging | **Speculative multi-depth merge queue** testing concurrent changes in temporary JJ/Git workspaces. |
| **CLI & Execution** | Fixed CLI naming | Dual CLI binaries: **`corral`** and backward-compatible **`ralph`**. |

---

## 3. CLI Quickstart

Launch any specification or natural language task:

```bash
# Launch with canonical 'corral' command
corral "Implement distributed transaction coordinator"

# Or use the classic 'ralph' alias
ralph ./specs/feature.md --max-concurrency 8

# Non-interactive / CI mode
corral "Fix authentication timeout" --skip-questions --max-iterations 15

# Dry run (generate workflow without starting engine)
corral ./PROMPT.md --dry-run
```

### CLI Flags

| Flag | Type | Description | Default |
|---|---|---|---|
| `--cwd <path>` | `string` | Target repository root | Current working directory |
| `--max-concurrency <n>` | `number` | Maximum parallel active tickets | `4` |
| `--max-iterations <n>` | `number` | Hard loop ceiling for Ralph convergence | `25` |
| `--skip-questions` | `boolean` | Bypass interactive clarification phase | `false` |
| `--dry-run` | `boolean` | Generate workflow files without executing | `false` |
| `--run-id <id>` | `string` | Explicit Smithers run identifier | Auto-generated UUID |

---

## 4. Verification & Quality Gates

- **Unit & Integration Suite**: **46/46 tests passing** (`bun test`).
- **TypeScript Typecheck**: **0 diagnostics** (`tsc --noEmit` clean).
- **Syntax Guard**: Verified clean via `syntax-guard` (Rust AST linters).
