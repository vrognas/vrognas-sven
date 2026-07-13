import { describe, it, expect, vi } from "vitest";
import { TreeItem, Uri } from "vscode";
import { RepoLogProvider } from "../../../src/historyView/repoLogProvider";
import { ICachedLog, LogTreeItemKind } from "../../../src/historyView/common";
import { ISvnLogEntry } from "../../../src/common/types";

/**
 * fetchAll holds isLoading=true for its whole multi-chunk run and fires
 * a tree refresh per chunk ("streams entries into the tree"). But
 * getChildren used to short-circuit to a lone "Loading..." item whenever
 * isLoading - each chunk REPLACED the visible history with a spinner for
 * the entire run.
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

function harness(cached: ICachedLog) {
  const mockThis = {
    getCached: () => cached,
    filterService: { getFilter: () => undefined, hasActiveFilter: () => false },
    logCache: new Map([[REPO_URL, cached]]),
    itemCaches: new WeakMap(),
    _onDidChangeTreeData: { fire: vi.fn() }
  };
  const getChildren = (
    RepoLogProvider.prototype as unknown as Record<string, unknown>
  ).getChildren as (
    this: unknown,
    e?: unknown
  ) => { kind: number; data: unknown }[];
  return { mockThis, getChildren };
}

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

describe("fetchAll streaming render", () => {
  it("keeps loaded commits visible while a bulk fetch is in flight", () => {
    const cached = makeCached({
      entries: [entry("3000"), entry("2999")],
      isLoading: true
    });
    const { mockThis, getChildren } = harness(cached);

    const items = getChildren.call(mockThis, undefined);

    const commits = items.filter(i => i.kind === LogTreeItemKind.Commit);
    expect(commits).toHaveLength(2);

    const labels = items
      .filter(i => i.kind === LogTreeItemKind.TItem)
      .map(i => String((i.data as TreeItem).label));
    expect(labels).toContain("Loading..."); // progress appended, not replacing
    expect(labels.some(l => l.includes("Load all"))).toBe(false);
  });

  it("still shows the lone loading item when nothing is loaded yet", () => {
    const cached = makeCached({ entries: [], isLoading: true });
    const { mockThis, getChildren } = harness(cached);

    const items = getChildren.call(mockThis, undefined);

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe(LogTreeItemKind.TItem);
  });
});
