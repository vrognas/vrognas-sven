import { describe, it, expect, vi } from "vitest";
import { Uri } from "vscode";
import { BlameProvider } from "../../../src/blame/blameProvider";
import { ISvnBlameLine } from "../../../src/common/types";

/**
 * After blame renders we KNOW every revision that touched the file -
 * pre-warm the per-revision diffs (peek previews) and neighbor contents
 * (walk hops) in the background so the first "Peek Changes" is fast.
 * Historical blames stay lazy: prefetching those would hammer the server.
 */

const uri = Uri.file("/ws/model.R");

function blameLine(line: number, revision: string): ISvnBlameLine {
  return { lineNumber: line, revision, author: "a", date: "d" } as never;
}

function harness() {
  const patchRevision = vi.fn(
    async (_rev: string, _uri: unknown) => "@@ -1 +1 @@\n+x\n"
  );
  const show = vi.fn(
    async (_f: string, _rev?: string, _peg?: string) => "content"
  );
  const getInfo = vi.fn(async () => ({ revision: "3000" }));
  const mockThis: Record<string, unknown> = {
    repository: { repository: { patchRevision, show, getInfo } },
    peekPrefetchDone: new Set<string>()
  };
  mockThis.repoFor = () => mockThis.repository;
  const prefetch = (
    BlameProvider.prototype as unknown as Record<string, unknown>
  ).prefetchPeekData as (
    this: unknown,
    uri: Uri,
    blameData: ISvnBlameLine[]
  ) => Promise<void>;
  return { mockThis, prefetch, patchRevision, show };
}

describe("peek-data prefetch", () => {
  it("warms diffs and neighbor contents for each unique blame revision", async () => {
    const { mockThis, prefetch, patchRevision, show } = harness();
    const data = [
      blameLine(1, "42"),
      blameLine(2, "42"), // duplicate revision - fetched once
      blameLine(3, "7")
    ];

    await prefetch.call(mockThis, uri, data);

    const patched = patchRevision.mock.calls.map(c => c[0]);
    expect(patched).toEqual(["42", "7"]); // newest first, deduped
    // neighbor content at REV-1 pegged at BASE for the walk's mapping
    expect(show).toHaveBeenCalledWith(uri.fsPath, "41", "3000");
    expect(show).toHaveBeenCalledWith(uri.fsPath, "6", "3000");
  });

  it("runs once per file and aborts the sweep on network failure", async () => {
    const { mockThis, prefetch, patchRevision } = harness();
    patchRevision.mockRejectedValue(new Error("E170013 offline"));
    const data = [blameLine(1, "42"), blameLine(2, "7")];

    await prefetch.call(mockThis, uri, data);
    // first failure aborts - no second doomed fetch
    expect(patchRevision).toHaveBeenCalledTimes(1);

    await prefetch.call(mockThis, uri, data);
    // once-per-file guard: no re-sweep on the next render
    expect(patchRevision).toHaveBeenCalledTimes(1);
  });

  it("caps the sweep for files with huge revision counts", async () => {
    const { mockThis, prefetch, patchRevision } = harness();
    const data = Array.from({ length: 60 }, (_, i) =>
      blameLine(i + 1, String(1000 + i))
    );

    await prefetch.call(mockThis, uri, data);

    // Warm only the few newest revisions - the default peek fetches any
    // colder line on demand, so a wide sweep just storms the server.
    expect(patchRevision.mock.calls.length).toBeLessThanOrEqual(5);
    // newest revisions win the budget
    expect(patchRevision.mock.calls[0]![0]).toBe("1059");
  });
});
