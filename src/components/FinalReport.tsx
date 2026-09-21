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
    "You MUST output a JSON object with exactly this shape:",
    '{"reply": "the reply text here"}',
    "",
    "Rules:",
    "- If the original prompt is a simple direct instruction (for example: 'reply with exactly the word ALIVE'), the reply field must contain EXACTLY what was asked, byte for byte.",
    '- Example: for \'reply with exactly the word ALIVE\', output {"reply": "ALIVE"}. The value is ALIVE (5 characters).',
    "- Do NOT put quotation marks inside the reply value. The JSON syntax already quotes the value; do not double-quote it.",
    "- Do NOT add preamble, commentary, markdown fences, or explanation outside the JSON.",
    "- Otherwise, write a concise completion summary in the reply field: what was requested, what was accomplished, key outcomes, and anything left unfinished.",
    "- Output ONLY the JSON object, nothing else.",
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
