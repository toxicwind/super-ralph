/**
 * Shared exact-reply helpers for byte-exact prompts
 * (e.g. "Reply with exactly the five-letter word ALIVE and nothing else.").
 *
 * Root cause of the accept12-20260921 failure (exit 2, empty stdout):
 *  1. The old detector regex only matched the literal phrasing
 *     "exactly the word X", but the prompt said "exactly the five-letter
 *     word ALIVE" -> no match, so the deterministic pre-check in
 *     CompletionValidator was silently skipped.
 *  2. The zod quote-strip transform in finalReportOutputSchema does NOT
 *     propagate to the persisted DB row (the orchestrator stores the raw
 *     agent output), so ctx.latest("final_report") returned `"ALIVE"`
 *     (7 bytes). The LLM validator - correctly told that quotes are literal
 *     bytes - judged valid=false, and the Ralph wrapper
 *     (maxIterations=1, onMaxReached="fail") turned that into exit 2 with
 *     no completion_validator row and no stdout.
 *
 * The validator and the CLI must therefore judge/print the NORMALIZED reply:
 * what the user actually sees, not the raw stored bytes.
 */

/** Matches "exactly the word X" and adjective variants like "exactly the five-letter word X". */
export const EXACT_REPLY_RE =
  /exactly the (?:[a-z]+(?:[- ][a-z]+)* )?word ([A-Za-z0-9]+)/i;

/** Extract the expected exact reply word from a prompt, or null if the prompt is not an exact-reply prompt. */
export function detectExactReply(prompt: string): string | null {
  const m = prompt.match(EXACT_REPLY_RE);
  return m ? m[1] : null;
}

/**
 * Normalize a final reply for byte comparison/printing: trim, then strip one
 * pair of surrounding double-quotes (agents habitually emit `"ALIVE"` for
 * ALIVE). Idempotent - safe to apply to already-clean replies.
 */
export function normalizeReply(reply: string): string {
  let t = reply.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1).trim();
  }
  return t;
}
