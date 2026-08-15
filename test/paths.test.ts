/**
 * Unit tests for fleet/stats/paths.ts rel-path classification.
 *
 * isMainSession must accept both `proj/file.jsonl` and `proj\file.jsonl`
 * (Windows-style) on every OS, keep the `.jsonl` suffix rule and the
 * `__advisor` file-name exclusion, and reject anything that isn't exactly
 * two segments. folderOf keeps first-segment semantics on native rel paths.
 */
import { describe, expect, test } from "bun:test";
import { folderOf, isMainSession } from "../fleet/stats/paths";

describe("isMainSession", () => {
  test("forward-slash rel path", () => {
    expect(isMainSession("proj/file.jsonl")).toBe(true);
  });

  test("backslash rel path normalizes to forward", () => {
    expect(isMainSession("proj\\file.jsonl")).toBe(true);
  });

  test("mixed separators normalize", () => {
    expect(isMainSession("proj\\sub\\file.jsonl")).toBe(false); // 3 segments after normalization
    expect(isMainSession("proj\\sub/file.jsonl")).toBe(false); // 3 segments after normalization
  });

  test("rejects single-segment files", () => {
    expect(isMainSession("file.jsonl")).toBe(false);
  });

  test("rejects non-jsonl suffix", () => {
    expect(isMainSession("proj/notes.txt")).toBe(false);
    expect(isMainSession("proj\\notes.txt")).toBe(false);
  });

  test("rejects __advisor files (file-name exclusion)", () => {
    expect(isMainSession("proj/__advisor-notes.jsonl")).toBe(false);
    expect(isMainSession("proj\\__advisor-notes.jsonl")).toBe(false);
  });

  test("rejects deeper paths", () => {
    expect(isMainSession("proj/sub/file.jsonl")).toBe(false);
    expect(isMainSession("a/b/c.jsonl")).toBe(false);
    expect(isMainSession("a\\b\\c.jsonl")).toBe(false);
  });

  test("still accepts plain main sessions after normalization", () => {
    expect(isMainSession("proj/file.jsonl")).toBe(true);
    expect(isMainSession("proj\\file.jsonl")).toBe(true);
  });
});

describe("folderOf", () => {
  test("first segment of a native rel path", () => {
    expect(folderOf("proj/file.jsonl")).toBe("proj");
    expect(folderOf("proj/sub/file.jsonl")).toBe("proj");
  });

  test("no separator returns the whole rel", () => {
    expect(folderOf("proj")).toBe("proj");
    expect(folderOf("file.jsonl")).toBe("file.jsonl");
  });
});
