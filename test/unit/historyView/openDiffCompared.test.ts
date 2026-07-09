import { describe, it, expect, vi, beforeEach } from "vitest";
import { Uri, commands, window } from "vscode";
import { openDiffCompared } from "../../../src/historyView/common";
import { IRemoteRepository } from "../../../src/remoteRepository";

const target = Uri.parse("https://example.com/repo/trunk/file.txt");

function makeRepo(overrides: Partial<IRemoteRepository> = {}) {
  return {
    show: vi.fn(async (_t: Uri | string, rev?: string) => `content@${rev}`),
    patchRevision: vi.fn(async () => "Property changes on: file.txt\n"),
    ...overrides
  } as unknown as IRemoteRepository & {
    show: ReturnType<typeof vi.fn>;
    patchRevision: ReturnType<typeof vi.fn>;
  };
}

describe("openDiffCompared", () => {
  beforeEach(() => {
    vi.mocked(commands.executeCommand).mockClear();
  });

  it("fetches both revisions in PARALLEL and opens the diff", async () => {
    let resolveLeft!: (v: string) => void;
    let resolveRight!: (v: string) => void;
    const started: string[] = [];
    const repo = makeRepo({
      show: vi.fn((_t: Uri | string, rev?: string) => {
        started.push(rev!);
        return new Promise<string>(res => {
          if (rev === "99") resolveLeft = res;
          else resolveRight = res;
        });
      }) as unknown as IRemoteRepository["show"]
    });

    const done = openDiffCompared(repo, target, "99", "100");
    // Both fetches must be in flight before either resolves - the old flow
    // awaited them sequentially (plus a discarded `svn diff` pre-check)
    await Promise.resolve();
    expect(started).toEqual(["99", "100"]);

    resolveLeft("old content");
    resolveRight("new content");
    await done;

    const diffCall = vi
      .mocked(commands.executeCommand)
      .mock.calls.find(c => c[0] === "vscode.diff");
    expect(diffCall).toBeDefined();
    expect(String(diffCall![3])).toContain("(99 : 100)");
  });

  it("detects property-only changes by content equality and shows the patch", async () => {
    const repo = makeRepo({
      show: vi.fn(
        async () => "identical"
      ) as unknown as IRemoteRepository["show"]
    });

    await openDiffCompared(repo, target, "99", "100");

    // Identical content => the change was property-only: patch is fetched
    // (only now - not as a pre-check on every click) and opened
    expect(repo.patchRevision).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(commands.executeCommand).mock.calls;
    expect(calls.some(c => c[0] === "vscode.diff")).toBe(false);
    expect(calls.some(c => c[0] === "vscode.open")).toBe(true);
  });

  it("reuses a pre-started right-side fetch and reports fetch failures", async () => {
    const repo = makeRepo();
    const right = Promise.resolve("prefetched");
    await openDiffCompared(repo, target, "99", "100", right);
    // Left fetched via show, right came from the provided promise
    expect(repo.show).toHaveBeenCalledTimes(1);
    expect(repo.show).toHaveBeenCalledWith(target, "99");

    const failing = makeRepo({
      show: vi.fn(async () => {
        throw new Error("E175002 timeout");
      }) as unknown as IRemoteRepository["show"]
    });
    await openDiffCompared(failing, target, "1", "2");
    expect(vi.mocked(window.showErrorMessage)).toHaveBeenCalled();
  });
});
