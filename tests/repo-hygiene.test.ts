import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * iCloud sync created conflict duplicates ("index 2.ts", ".git/refs/heads/main 2")
 * while the repo lived under ~/Desktop, and six of them were committed before
 * anyone noticed. The repo has moved off iCloud, but this keeps the class of
 * junk from returning silently.
 */
describe("repository hygiene", () => {
  it("tracks no conflict-copy files", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
    const conflicts = tracked.filter((f) => / \d+\.[a-z]+$/.test(f));
    expect(conflicts, `conflict copies committed: ${conflicts.join(", ")}`).toEqual([]);
  });
});
