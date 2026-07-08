import * as assert from "assert";
import { vi } from "vitest";
import { RepoLogProvider } from "../../../historyView/repoLogProvider";
import { ICachedLog } from "../../../historyView/common";
import { ISvnLogEntry } from "../../../common/types";

const REPO_URL = "http://server/repo/trunk";

function makeEntry(revision: string): ISvnLogEntry {
  return {
    revision,
    author: "alice",
    msg: `commit ${revision}`,
    date: "2026-07-08T00:00:00.000000Z",
    paths: []
  } as unknown as ISvnLogEntry;
}

// Minimal `this` for RepoLogProvider.prototype.refresh - avoids the heavy
// constructor (tree view + command registration)
function makeMock(repoRevision: string, cached?: Partial<ICachedLog>) {
  const branchRoot = { toString: (_skipEncoding?: boolean) => REPO_URL };
  const repo: any = {
    branchRoot,
    repository: { info: { revision: repoRevision } },
    clearLogCache: vi.fn()
  };
  const logCache = new Map<string, ICachedLog>();
  if (cached) {
    logCache.set(REPO_URL, {
      entries: [],
      revisionSet: new Set(),
      isComplete: false,
      repo,
      svnTarget: branchRoot as any,
      persisted: { commitFrom: "HEAD" },
      order: 0,
      ...cached
    } as ICachedLog);
  }
  const mockThis: any = {
    logCache,
    filterService: { getFilter: () => undefined },
    sourceControlManager: { repositories: [repo] },
    treeView: { visible: true },
    _onDidChangeTreeData: { fire: vi.fn() },
    evictOldestLogEntry: () => {}
  };
  return { mockThis, logCache };
}

const refresh = RepoLogProvider.prototype.refresh;

suite("RepoLogProvider explicit refresh at-newest skip", () => {
  test("entries already covering the WC revision survive explicit refresh", async () => {
    const entries = [makeEntry("105"), makeEntry("100")];
    const { mockThis, logCache } = makeMock("105", {
      entries,
      revisionSet: new Set(["105", "100"]),
      isComplete: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });

    await refresh.call(mockThis, undefined, false, true);

    const cached = logCache.get(REPO_URL)!;
    assert.strictEqual(
      cached.entries.length,
      2,
      "history <= WC revision is immutable - no refetch needed"
    );
    assert.strictEqual(
      cached.persisted.baseRevision,
      105,
      "BASE marker must move to the updated revision"
    );
    assert.strictEqual(cached.isComplete, true, "isComplete preserved");
  });

  test("entries behind the WC revision still trigger a refetch", async () => {
    const { mockThis, logCache } = makeMock("105", {
      entries: [makeEntry("100")],
      revisionSet: new Set(["100"]),
      isComplete: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });

    await refresh.call(mockThis, undefined, false, true);

    const cached = logCache.get(REPO_URL)!;
    assert.strictEqual(
      cached.entries.length,
      0,
      "stale cache (e.g. post-commit) must clear so the view refetches"
    );
    assert.strictEqual(cached.isComplete, false);
    assert.strictEqual(cached.persisted.baseRevision, 105);
  });

  test("in-flight load disables the skip", async () => {
    const { mockThis, logCache } = makeMock("105", {
      entries: [makeEntry("105")],
      revisionSet: new Set(["105"]),
      isComplete: false,
      isLoading: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });

    await refresh.call(mockThis, undefined, false, true);

    const cached = logCache.get(REPO_URL)!;
    assert.strictEqual(
      cached.entries.length,
      0,
      "partially loaded caches must not be preserved"
    );
  });
});
