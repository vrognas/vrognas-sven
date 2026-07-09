import { describe, it, expect, vi } from "vitest";
import { Uri } from "vscode";
import { RepoLogProvider } from "../../../src/historyView/repoLogProvider";
import { ICachedLog } from "../../../src/historyView/common";
import { ISvnLogEntry } from "../../../src/common/types";

/**
 * refresh() used to read `prev` from logCache AFTER logCache.clear() -
 * always undefined. On every debounced (non-explicit) refresh that
 * dropped isComplete/fullHistory (resurrecting Load more on a complete
 * history and disabling the local-filter fast path), killed the
 * revisionChanged staleness detection, and replaced the cache object,
 * silently cancelling in-flight fetchAll/goToRevision identity guards.
 */

function entry(revision: string): ISvnLogEntry {
  return {
    revision,
    author: "a",
    msg: "m",
    date: "2026-01-01T00:00:00.000000Z",
    paths: []
  } as unknown as ISvnLogEntry;
}

const REPO_URL = "http://srv/repo/trunk";

function makeCached(partial: Partial<ICachedLog>): ICachedLog {
  const entries = partial.entries ?? [];
  return {
    entries,
    revisionSet: new Set(entries.map(e => e.revision)),
    svnTarget: Uri.parse(REPO_URL),
    isComplete: false,
    repo: {} as never,
    persisted: { commitFrom: "HEAD" },
    ...partial
  };
}

function makeHarness(prev: ICachedLog | undefined, wcRevision: string) {
  const logCache = new Map<string, ICachedLog>();
  if (prev) {
    logCache.set(REPO_URL, prev);
  }
  const repo = {
    branchRoot: Uri.parse(REPO_URL),
    repository: { info: { revision: wcRevision } },
    clearLogCache: vi.fn()
  };
  const mockThis = {
    logCache,
    sourceControlManager: { repositories: [repo] },
    filterService: { getFilter: () => undefined },
    treeView: { visible: true },
    _onDidChangeTreeData: { fire: vi.fn() }
  };
  const refresh = (
    RepoLogProvider.prototype as unknown as Record<string, unknown>
  ).refresh as (
    this: unknown,
    element?: unknown,
    fetchMoreClick?: boolean,
    explicitRefresh?: boolean
  ) => Promise<void>;
  return { mockThis, logCache, refresh };
}

describe("repoLog refresh cache preservation", () => {
  it("debounced refresh keeps isComplete/fullHistory AND object identity", async () => {
    const prev = makeCached({
      entries: [entry("3000")],
      isComplete: true,
      fullHistory: true,
      persisted: { commitFrom: "HEAD", baseRevision: 3000 }
    });
    const { mockThis, logCache, refresh } = makeHarness(prev, "3000");

    await refresh.call(mockThis); // onDidChangeRepository debounce path

    const now = logCache.get(REPO_URL)!;
    expect(now.isComplete).toBe(true);
    expect(now.fullHistory).toBe(true);
    // identity guards of in-flight fetchAll/goToRevision compare objects
    expect(now).toBe(prev);
  });

  it("debounced refresh clears stale entries after an external update", async () => {
    // svn update ran in a terminal: WC moved 2990 -> 3000, no explicit
    // refresh fired - the cached window no longer matches BASE
    const prev = makeCached({
      entries: [entry("2990")],
      isComplete: true,
      persisted: { commitFrom: "HEAD", baseRevision: 2990 }
    });
    const { mockThis, logCache, refresh } = makeHarness(prev, "3000");

    await refresh.call(mockThis);

    const now = logCache.get(REPO_URL)!;
    expect(now.entries).toHaveLength(0);
    expect(now.persisted.baseRevision).toBe(3000);
    expect(now.isComplete).toBe(false);
  });

  it("explicit refresh still invalidates the cache object", async () => {
    const prev = makeCached({
      entries: [entry("2990")],
      persisted: { commitFrom: "HEAD", baseRevision: 2990 }
    });
    const { mockThis, logCache, refresh } = makeHarness(prev, "3000");

    await refresh.call(mockThis, undefined, false, true);

    const now = logCache.get(REPO_URL)!;
    expect(now).not.toBe(prev);
    expect(now.entries).toHaveLength(0); // refetch from server
    expect(now.persisted.baseRevision).toBe(3000);
  });
});
