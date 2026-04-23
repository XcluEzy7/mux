import { describe, expect, test } from "@jest/globals";
import { execFileAsync } from "../../src/node/utils/disposableExec";
import { addFakeOrigin, cleanupTempGitRepo, createTempGitRepo } from "./helpers";

async function runGit(args: string[], repoPath: string): Promise<string> {
  using proc = execFileAsync("git", ["-C", repoPath, ...args]);
  const { stdout } = await proc.result;
  return stdout.trim();
}

describe("ipc git helpers", () => {
  test("temp repos keep branch and upstream git output non-empty across repeated setup", async () => {
    for (let i = 0; i < 5; i += 1) {
      const repoPath = await createTempGitRepo();

      try {
        const branch = await runGit(["branch", "--show-current"], repoPath);
        expect(branch).not.toBe("");

        await addFakeOrigin(repoPath);

        const upstream = await runGit(
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          repoPath
        );
        expect(upstream).toBe(`origin/${branch}`);
      } finally {
        await cleanupTempGitRepo(repoPath);
      }
    }
  });
});
