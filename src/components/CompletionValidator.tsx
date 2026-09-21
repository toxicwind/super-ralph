import React from "react";
import { Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import { z } from "zod";
import { selectProgressSummary } from "../selectors";

export const completionValidatorOutputSchema = z.object({
  valid: z.boolean(),
  unmetCriteria: z.array(z.string()),
  summary: z.string().min(1),
});

export type CompletionValidatorOutput = z.infer<
  typeof completionValidatorOutputSchema
>;

export type CompletionValidatorProps = {
  prompt: string;
  agent: any;
  output?: any;
  ctx: SmithersCtx;
};

/**
 * CompletionValidator Smithers Component - structured completion check at quiescence.
 *
 * Terminal guard of a finite super-ralph run. Runs once, AFTER the FinalReport
 * step. It extracts the concrete completion criteria from the original prompt
 * and checks each one against the final reply the workflow actually produced.
 *
 * Quiescence (the work loops exited because no work remained) is NOT the same
 * as completion (the original goal is actually satisfied). This component
 * closes that gap.
 *
 * Wiring: the CLI template wraps this in
 *   <Ralph until={verdict.valid} maxIterations={1} onMaxReached="fail">
 * so valid=false is LOUD: non-zero exit, failed workflow row, no reply
 * printed as success. A run that stops without satisfying its goal must
 * never exit 0.
 */
export function CompletionValidator({
  prompt,
  agent,
  output,
  ctx,
}: CompletionValidatorProps) {
  const finalReport = ctx.latest("final_report", "final-report") as {
    reply?: string;
  } | null;
  const reply =
    typeof finalReport?.reply === "string" && finalReport.reply.length > 0
      ? finalReport.reply
      : "(no final report was produced)";
  const replyBytes = Buffer.byteLength(reply, "utf8");
  const progressSummary = selectProgressSummary(ctx);

  const validatorPrompt = [
    "You are the completion validator for a finished super-ralph autonomous workflow run.",
    "The work loops have exited and the final reply has been produced. Your job is to verify the ORIGINAL goal is actually satisfied by that reply — not just that work stopped.",
    "",
    "Original user prompt:",
    prompt,
    "",
    "Final reply produced by the workflow (EXACT bytes, between the markers):",
    ">>>",
    reply,
    "<<<",
    `Byte length of the reply: ${replyBytes}`,
    "WARNING: Quotation marks (\") in the reply are LITERAL bytes, not formatting. If the reply shows \"ALIVE\" between the markers, it is 7 bytes, not 5.",
    "",
    "Progress summary:",
    progressSummary ?? "(none recorded)",
    "",
    "Rules:",
    "- Extract the concrete, checkable completion criteria from the original prompt.",
    "- For a simple direct instruction (for example: 'reply with exactly the word ALIVE'), the criterion is literal: the final reply must satisfy it EXACTLY, byte for byte. Compare the byte length first. 'ALIVE' (5 bytes) is not '\"ALIVE\"' (7 bytes), not 'Alive', not 'ALIVE!', not a sentence containing ALIVE.",
    "- Check EVERY criterion against the final reply and the progress summary. Be strict: a criterion counts as met only if the evidence shows it DONE, not merely attempted.",
    "- Set valid=true only if ALL criteria are met. Otherwise valid=false and list each unmet criterion concretely in unmetCriteria.",
    "- summary: one paragraph stating what was verified and what (if anything) is missing.",
    "- Output ONLY the structured verdict.",
  ].join("\n");

  return (
    <Task
      id="completion-validator"
      output={output ?? completionValidatorOutputSchema}
      agent={agent}
      retries={1}
    >
      {validatorPrompt}
    </Task>
  );
}
