/**
 * Finite-by-default acceptance tests.
 *
 * Super Ralph must terminate: every <Ralph> loop carries a live `until`
 * exit condition, a bounded maxIterations with onMaxReached="fail", and
 * no infinite declarations anywhere in the generated workflow.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "sr-finite-test-"));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

async function dryRun(extraArgs: string[] = []): Promise<string> {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "reply with exactly the word ALIVE", "--cwd", workdir, "--dry-run", ...extraArgs],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`dry-run failed (exit ${code}): ${stderr}\n${stdout}`);
  return readFileSync(join(workdir, ".super-ralph", "generated", "workflow.tsx"), "utf-8");
}

describe("finite-by-default", () => {
  const componentSrc = readFileSync(join(import.meta.dir, "..", "src", "components", "SuperRalph.tsx"), "utf-8");

  test("Ralph loops use a live exit condition, never an infinite one", () => {
    // strip comments: the source documents why `until={false}` was broken
    const code = componentSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("until={false}");
    expect(code).not.toContain("Infinity");
    // one shared quiescence predicate drives all three loop exits
    expect(code).toContain("allWorkComplete");
    const untilCount = (code.match(/until=\{allWorkComplete\}/g) ?? []).length;
    expect(untilCount).toBe(3);
    expect(code).toContain("maxIterations={maxIterations}");
    expect(code).toContain('onMaxReached="fail"');
  });

  test("generated workflow has no infinite declarations", async () => {
    const wf = await dryRun();
    expect(wf).not.toContain("until={false}");
    expect(wf).not.toContain("Infinity");
  });

  test("iteration budget is finite and defaults to 25", async () => {
    const wf = await dryRun();
    expect(wf).toContain("const MAX_ITERATIONS = 25;");
    expect(wf).toContain('onMaxReached="fail"');
  });

  test("--max-iterations overrides the default", async () => {
    const wf = await dryRun(["--max-iterations", "7"]);
    expect(wf).toContain("const MAX_ITERATIONS = 7;");
  });

  test("generated workflow contains no Monitor", async () => {
    const wf = await dryRun();
    // The finite workflow has no interactive sibling: the Monitor dashboard
    // is a separately supervised concern, not part of a finite run.
    expect(wf).not.toContain("Monitor");
    expect(wf).not.toContain("INCLUDE_MONITOR");
  });

  test("final report step terminates the run", async () => {
    const wf = await dryRun();
    expect(wf).toContain("FinalReport");
    expect(wf).toContain("final_report");
  });
});

describe("final report schema", () => {
  test("validates an exact reply", async () => {
    const { finalReportOutputSchema } = await import("../src/components/FinalReport");
    const parsed = finalReportOutputSchema.safeParse({ reply: "ALIVE" });
    expect(parsed.success).toBe(true);
  });

  test("rejects non-string replies", async () => {
    const { finalReportOutputSchema } = await import("../src/components/FinalReport");
    expect(finalReportOutputSchema.safeParse({ reply: 42 }).success).toBe(false);
    expect(finalReportOutputSchema.safeParse({}).success).toBe(false);
  });

  test("final_report output schema is registered", async () => {
    const { ralphOutputSchemas } = await import("../src/schemas");
    expect(Object.keys(ralphOutputSchemas)).toContain("final_report");
  });
});
