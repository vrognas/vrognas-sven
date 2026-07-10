import { describe, it, expect, vi, beforeEach } from "vitest";
import { Uri, commands, window } from "vscode";
import { openBlameRevisionDiff } from "../../../src/blame/blameDiff";
import { ISvnLogEntry } from "../../../src/common/types";

const uri = Uri.file("/ws/src/model.R");

const entry = (revision: string): ISvnLogEntry =>
  ({ revision, author: "a", msg: "m", date: "d", paths: [] }) as never;

function makeSource(revs: string[]) {
  return {
    log: vi.fn(async () => revs.map(entry)),
    show: vi.fn(async (_t: unknown, rev?: string) => `content@${rev}`),
    getInfo: vi.fn(async () => ({ revision: "3000" })),
    patchRevision: vi.fn(async () => "Property changes only\n")
  };
}

describe("openBlameRevisionDiff (blame hover: diff with previous)", () => {
  beforeEach(() => {
    vi.mocked(commands.executeCommand).mockClear();
    vi.mocked(window.showInformationMessage).mockClear();
  });

  it("resolves the file's ACTUAL previous revision via pegged log and diffs", async () => {
    // blame says line changed in r100; the file's previous change was r42
    const source = makeSource(["100", "42"]);

    await openBlameRevisionDiff(source, uri, "100");

    // UNPEGGED log on the WC path: the default BASE peg makes svn trace
    // the file's lineage back through renames from r100 downward
    expect(source.log).toHaveBeenCalledWith("100", "1", 2, uri);
    const diffCall = vi
      .mocked(commands.executeCommand)
      .mock.calls.find(c => c[0] === "vscode.diff");
    expect(diffCall).toBeDefined();
    expect(String(diffCall![3])).toContain("(42 : 100)");
  });

  it("falls back to viewing the revision content when it added the file", async () => {
    const source = makeSource(["100"]); // no previous change exists

    await openBlameRevisionDiff(source, uri, "100");

    // no diff - the file content at r100 opens instead; the explanation
    // is inline status-bar feedback, not a toast
    const calls = vi.mocked(commands.executeCommand).mock.calls;
    expect(calls.some(c => c[0] === "vscode.diff")).toBe(false);
    expect(calls.some(c => c[0] === "vscode.open")).toBe(true);
    expect(vi.mocked(window.setStatusBarMessage)).toHaveBeenCalled();
  });
});
