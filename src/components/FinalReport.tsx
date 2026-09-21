import React from "react";
import { Task } from "smithers-orchestrator";
import { z } from "zod";

export const finalReportOutputSchema = z.object({
  reply: z.string().min(1).transform((s) => s.trim()),
});

export type FinalReportOutput = z.infer<typeof finalReportOutputSchema>;

export type FinalReportProps = {
  prompt: string;
  agent: any;
  output?: any;
};

/**
 * FinalReport Smithers Component - terminal step of a finite super-ralph run.
 *
 * Runs once, after the work loops have exited. Produces the final reply to the
 * user, which the CLI prints as the last line of output. For a simple direct
 * instruction (e.g. "reply with exactly the word ALIVE") the reply is exactly
 * what was asked; otherwise it is a concise completion summary.
 */
export function FinalReport({ prompt, agent, output }: FinalReportProps) {
  const reportPrompt = [
    "You are the final reporter for a completed super-ralph autonomous workflow run.",
    "The workflow has finished. Produce the final reply to the user.",
    "",
    "Original user prompt:",
    prompt,
    "",
    "Rules:",
    "- If the original prompt is a simple direct instruction (for example: 'reply with exactly the word ALIVE'), follow it EXACTLY. Output only what was asked - no preamble, no commentary, no markdown fences, no explanation.",
    "- CRITICAL: Output the raw reply text with NO surrounding quotation marks. If asked for ALIVE, output ALIVE (5 bytes), NOT \"ALIVE\" (7 bytes). The quotes are not part of the reply.",
    "- Otherwise, write a concise completion summary: what was requested, what was accomplished, key outcomes, and anything left unfinished.",
    "- Output ONLY the reply text itself.",
  ].join("\n");

  return (
    <Task
      id="final-report"
      output={output ?? finalReportOutputSchema}
      agent={agent}
      retries={2}
    >
      {reportPrompt}
    </Task>
  );
}
