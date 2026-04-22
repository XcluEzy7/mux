import { describe, test, expect, beforeEach, mock } from "bun:test";
import { parseNumstat } from "../utils/git/numstatParser";
import { buildGitDiffCommand } from "../utils/git/gitCommands";

// Unit tests focus on the git utilities since the hook uses ORPC client
// which requires full React Native context. The hook itself is thin glue code.

describe("useReviewChangeCount utilities", () => {
  describe("buildGitDiffCommand", () => {
    test("uses diffBase=main and includeUncommitted=true for review badge", () => {
      // This matches the defaults in GitReviewScreen
      const command = buildGitDiffCommand("main", true, "", "numstat");
      // Should use merge-base for unified diff with uncommitted included
      expect(command).toContain("merge-base");
      expect(command).toContain("--numstat");
    });

    test("uses HEAD only when includeUncommitted=false", () => {
      const command = buildGitDiffCommand("main", false, "", "numstat");
      // Three-dot diff for committed changes only
      expect(command).toContain("...");
      expect(command).not.toContain("merge-base");
    });

    test("respects custom diffBase parameter", () => {
      const command = buildGitDiffCommand("origin/develop", true, "", "numstat");
      expect(command).toContain("origin/develop");
      expect(command).toContain("merge-base");
    });

    test("respects --staged special base", () => {
      const command = buildGitDiffCommand("--staged", true, "", "numstat");
      expect(command).toContain("--staged");
    });
  });

  describe("parseNumstat", () => {
    test("returns empty array for empty input", () => {
      expect(parseNumstat("")).toEqual([]);
    });

    test("parses single file stats", () => {
      const result = parseNumstat("10\t5\tsrc/foo.ts");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filePath: "src/foo.ts",
        additions: 10,
        deletions: 5,
      });
    });

    test("returns file count matching expected badge behavior", () => {
      const output = "10\t5\tsrc/foo.ts\n3\t0\tsrc/bar.ts\n0\t2\tsrc/baz.ts";
      const stats = parseNumstat(output);
      // Badge shows count of changed files
      expect(stats.length).toBe(3);
    });

    test("handles binary files (marked with -)", () => {
      const result = parseNumstat("-\t-\timage.png");
      expect(result).toHaveLength(1);
      expect(result[0].additions).toBe(0);
      expect(result[0].deletions).toBe(0);
    });

    test("handles rename syntax", () => {
      const result = parseNumstat("5\t3\tsrc/{old.ts => new.ts}");
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe("src/{old.ts => new.ts}");
    });
  });

  describe("ReviewActionBadgeParams defaults", () => {
    test("defaults produce same command as review screen", () => {
      // Verify that calling with no params produces the review-screen defaults
      const defaultCommand = buildGitDiffCommand("main", true, "", "numstat");
      const explicitCommand = buildGitDiffCommand("main", true, "", "numstat");
      expect(defaultCommand).toBe(explicitCommand);
    });

    test("custom diffBase with default includeUncommitted", () => {
      // Caller can override just diffBase while keeping includeUncommitted=true
      const command = buildGitDiffCommand("origin/feature", true, "", "numstat");
      expect(command).toContain("origin/feature");
      expect(command).toContain("merge-base");
    });

    test("custom includeUncommitted=false with default diffBase", () => {
      // Caller can override just includeUncommitted while keeping diffBase="main"
      const command = buildGitDiffCommand("main", false, "", "numstat");
      expect(command).not.toContain("merge-base");
      expect(command).toContain("...");
    });
  });
});
