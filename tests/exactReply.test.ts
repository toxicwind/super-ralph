import { describe, expect, test } from "bun:test";
import { detectExactReply, normalizeReply, EXACT_REPLY_RE } from "../src/exactReply";

describe("detectExactReply", () => {
  test("matches the classic phrasing", () => {
    expect(detectExactReply("reply with exactly the word ALIVE")).toBe("ALIVE");
  });
  test("matches adjective variants (the accept12 prompt)", () => {
    expect(
      detectExactReply("Reply with exactly the five-letter word ALIVE and nothing else.")
    ).toBe("ALIVE");
  });
  test("matches hyphenated/multi adjectives", () => {
    expect(detectExactReply("Reply with exactly the single English word DONE.")).toBe("DONE");
  });
  test("returns null for non-exact prompts", () => {
    expect(detectExactReply("Write a summary of the sprint.")).toBeNull();
    expect(detectExactReply("Reply with the word ALIVE eventually.")).toBeNull();
  });
  test("regex is shared and consistent", () => {
    expect("Reply with exactly the five-letter word ALIVE and nothing else.".match(EXACT_REPLY_RE)?.[1]).toBe("ALIVE");
  });
});

describe("normalizeReply", () => {
  test("strips one pair of surrounding quotes", () => {
    expect(normalizeReply('"ALIVE"')).toBe("ALIVE");
  });
  test("trims whitespace", () => {
    expect(normalizeReply('  "ALIVE"  \n')).toBe("ALIVE");
  });
  test("leaves clean replies untouched (idempotent)", () => {
    expect(normalizeReply("ALIVE")).toBe("ALIVE");
    expect(normalizeReply(normalizeReply('"ALIVE"'))).toBe("ALIVE");
  });
  test("does not strip mismatched quotes", () => {
    expect(normalizeReply('"ALIVE')).toBe('"ALIVE');
  });
});
