
# super-ralph

> Reusable Ralph workflow - ticket-driven development with multi-agent review loops

> Fork of [roninjin10/super-ralph](https://github.com/roninjin10/super-ralph),
> with all model calls routed through a local nim-proxy (see below).

An opinionated [Smithers](https://smithers.sh) workflow. You just provide the specs, this workflow does the rest.

Deeper docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (full Smithers
orchestration design) and
[docs/CLI_CLARIFICATIONS.md](docs/CLI_CLARIFICATIONS.md) (how the
clarifying-questions phase works).

## Installation

```bash
bun add super-ralph smithers-orchestrator
```

## CLI

`super-ralph` can wrap this workflow directly from a prompt string or prompt file:

```bash
super-ralph "Build a merge queue dashboard with jj-native workflows"
super-ralph ./PROMPT.md
```

What the CLI does:
- Preflight checks for `jj` and gives install/setup instructions if missing
- Auto-detects `claude` and `codex` CLIs on startup
- Asks clarifying questions in an interactive terminal UI (skip with `--skip-questions`)
- Runs a first planning pass that interprets your prompt into `SuperRalph` props (focuses, test/build commands, checks, etc.)
- Generates a runnable workflow at `.super-ralph/generated/workflow.tsx`
- Runs Smithers with a built-in OpenTUI monitor (live terminal dashboard)
- Resolves nim-proxy routing once at startup so every model call goes through the proxy

Useful options:

```bash
super-ralph ./PROMPT.md --max-concurrency 12
super-ralph ./PROMPT.md --dry-run
super-ralph ./PROMPT.md --skip-questions
```

## Usage

```tsx
import {
  SuperRalph,
  ralphOutputSchemas,
} from "super-ralph";
import {
  createSmithers,
  ClaudeCodeAgent,
  CodexAgent,
} from "smithers-orchestrator";
import PRD from "./specs/PRD.mdx";
import EngineeringSpec from "./specs/Engineering.mdx";

const { smithers, outputs } = createSmithers(ralphOutputSchemas, {
  dbPath: "./workflow.db",
});

export default smithers((ctx) => (
  <SuperRalph
    ctx={ctx}
    outputs={outputs}
    focuses={[
      { id: "auth", name: "Authentication" },
      { id: "api", name: "API Server" },
    ]}
    projectId="my-project"
    projectName="My Project"
    specsPath="docs/specs/"
    referenceFiles={["docs/reference/"]}
    buildCmds={{ go: "go build ./...", rust: "cargo build" }}
    testCmds={{ go: "go test ./...", rust: "cargo test" }}
    postLandChecks={["make e2e"]}
    codeStyle="Go: snake_case, Rust: snake_case"
    reviewChecklist={["Spec compliance", "Test coverage", "Security"]}
    maxConcurrency={12}
    agents={{
      planning: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
      implementation: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
      testing: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
      reviewing: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
      reporting: new CodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), yolo: true }),
      mergeQueue: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
    }}
  >
    <PRD />
    <EngineeringSpec />
  </SuperRalph>
));
```

That's it! 30 lines of configuration for a complete workflow.

## Model routing via nim-proxy

By default every model call goes through the local nim-proxy
(http://127.0.0.1:8000, OpenAI-compatible) instead of direct provider APIs.

How it works:

- The CLI resolves NIM_PROXY_API_KEY once at startup (comma-separated for
  multi-key rotation, with 429/backoff rotation across keys) and injects
  NIM_BASE_URL (with /v1), NVIDIA_API_KEY, ANTHROPIC_BASE_URL and NIM_MODEL
  into its own env. Every downstream child process -- the claude NIM shim,
  generated smithers workflows, interactive UI -- inherits proxy routing.
  Keys travel in process env only and are never written to files.
- Clarifying-question generation uses proxyChatCompletions() directly
  against the proxy.
- Smithers ClaudeCodeAgent blanks ANTHROPIC_API_KEY on spawn but passes
  NIM_BASE_URL / NVIDIA_API_KEY through untouched, which is exactly what the
  claude NIM shim reads.

Env knobs:

- NIM_PROXY_API_KEY: proxy key (required; comma-separated enables rotation).
  Falls back to ANTHROPIC_API_KEY / NVIDIA_API_KEY when unset.
- NIM_PROXY_BASE_URL: proxy origin, default http://127.0.0.1:8000
  (a trailing /v1 is stripped for canonicalization).
- NIM_PROXY_MODEL: model id sent to the proxy, default openai/gpt-oss-20b.
- NIM_PROXY_BYPASS=1: escape hatch -- restore pre-proxy direct behavior.

With no key set the CLI fails fast with an actionable error instead of
silently falling back to direct APIs.

## The Pattern

Tickets are the **work unit**; **jobs are the scheduling unit**. An AI
scheduler (`TicketScheduler`, driven by the scheduler agent in your agent
pool) watches the ticket pipeline and writes jobs into a `scheduled_tasks`
table in the Smithers SQLite DB (`src/scheduledTasks.ts`, via `bun:sqlite`).
Three loops then run continuously and in parallel:

```
Ralph (infinite loop)
  ├─ Scheduler loop ── AI scheduler → scheduled_tasks (SQLite)
  │     ├─ UpdateProgress → PROGRESS.md
  │     ├─ CodebaseReview → per-focus reviews → tickets
  │     ├─ Discover → new feature tickets
  │     └─ IntegrationTest → per-focus test runs
  ├─ Execution loop ── one Job per scheduled job, in parallel worktrees
  │     └─ Per Job (on jj bookmark ticket/<id>)
  │        ├─ Research → gather context
  │        ├─ Plan → TDD plan
  │        ├─ ValidationLoop (loops until approved)
  │        │  ├─ Implement → write tests + code
  │        │  ├─ Test → run fast tests (pre-land checks)
  │        │  ├─ BuildVerify → check compilation
  │        │  ├─ SpecReview + CodeReview (parallel)
  │        │  └─ ReviewFix → fix issues
  │        └─ Report → completion summary
  └─ Merge queue loop ── speculative landing, runs independently
        └─ Land → speculative rebase stack, parallel post-land CI,
                   eviction + cascade re-test, fast-forward main, push
```

The scheduler only schedules when there is capacity (`maxConcurrency`), and
jobs are derived from *all* scheduler outputs — not just the latest — so no
scheduled work is lost between scheduler iterations.

### Live monitor

`Monitor` (`src/components/Monitor.tsx`) is an OpenTUI terminal dashboard
that runs alongside the workflow: a real-time task list with status
indicators, arrow-key navigation into task details, and overall progress —
all polled live from the Smithers SQLite DB. It starts automatically with the
CLI-generated workflow.

### Real speculative merge queue

Each ticket gets its own jj bookmark (`ticket/<id>`) in a dedicated worktree. Development happens in parallel across tickets, and landing uses a **stateful speculative queue**:

1. Queue order is computed from completed tickets
2. Tickets are speculatively rebased as a stack (`A <- B <- C`)
3. Post-land CI runs in parallel for the speculative window
4. Passing prefix is landed by fast-forwarding `main` to the furthest passing ticket
5. Failed ticket is evicted with context; downstream speculative tickets are re-rebased/re-tested
6. Ticket bookmark/worktree cleanup happens on merge and eviction

This means **no code lands on main without passing reviews AND post-rebase CI on speculative state**.

### Dedicated merge queue agent

`SuperRalph` supports a dedicated coordinator agent — any
`smithers-orchestrator` agent works here, e.g.:

```tsx
<SuperRalph
  agents={{
    planning: ...,
    implementation: ...,
    testing: ...,
    reviewing: ...,
    reporting: ...,
    mergeQueue: new KimiAgent({ model: "kimi-code/kimi-for-coding", cwd: process.cwd(), yolo: true, thinking: true }),
  }}
  mergeQueueOrdering="report-complete-fifo"
  maxSpeculativeDepth={3}
  postLandChecks={["make e2e", "bun test tests/integration/"]}
  {...otherProps}
/>
```

### Pre-land vs post-land checks

Configure which CI checks run in each phase:

```tsx
<SuperRalph
  // Fast checks run in the worktree during development (driven by testCmds/buildCmds/testSuites)
  testCmds={{ go: "go test ./...", rust: "cargo test" }}
  buildCmds={{ go: "go build ./..." }}

  // Slow checks run after rebase in the merge queue
  postLandChecks={["make e2e", "bun test tests/integration/"]}
  {...otherProps}
/>
```

If `postLandChecks` is not provided, it falls back to `testCmds`.

### jj-native workflow

All agents use jj commands instead of git:
- `jj describe` + `jj new` instead of `git commit`
- `jj bookmark set ticket/<id>` + `jj git push --bookmark` instead of `git push`
- `jj rebase` for landing instead of `git merge`

Requires a jj-colocated repo (`jj git init --colocate`).

This opinionated workflow is optimized in following ways:

- Observability: multiple reporting steps and lots of data stored in sqlite
- Quality: via CI checks, review loops, and context-engineered research-plan-implement steps
- Planning: Optimizes ralph by in real time generating tickets rather than hardcoding them up front
- Parallelization: All tickets implemented in a JJ Workspace in parallel with branch-per-ticket isolation
- Safe landing: Serialized merge queue with semantic conflict detection and post-rebase CI

## Advanced: Custom Components

Override any step with a custom component:

```tsx
<SuperRalph
  {...props}
  discover={<MyCustomDiscover agent={...} />}
/>
```

Or run additional logic in parallel:

```tsx
<SuperRalph
  {...props}
  discover={
    <Parallel>
      <SuperRalph.Discover agent={...} specsPath="..." referenceFiles={[...]} />
      <MyAdditionalDiscovery agent={...} />
    </Parallel>
  }
/>
```

These steps default to <SuperRalph.Component when not provided.

## License

MIT

