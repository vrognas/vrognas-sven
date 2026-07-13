import * as assert from "assert";
import { vi } from "vitest";
import { Uri, window } from "vscode";
import { RepoLogProvider } from "../../../historyView/repoLogProvider";
import { ICachedLog, LogTreeItemKind } from "../../../historyView/common";
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
    clearLogCache: vi.fn(),
    log: vi.fn().mockResolvedValue([])
  };
  const logCache = new Map<object, ICachedLog>();
  if (cached) {
    logCache.set(repo, {
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
  return { mockThis, logCache, repo };
}

const refresh = RepoLogProvider.prototype.refresh;

suite("RepoLogProvider explicit refresh at-newest skip", () => {
  test("entries already covering the WC revision survive explicit refresh", async () => {
    const entries = [makeEntry("105"), makeEntry("100")];
    const { mockThis, logCache, repo } = makeMock("105", {
      entries,
      revisionSet: new Set(["105", "100"]),
      isComplete: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });

    await refresh.call(mockThis, undefined, false, true);

    const cached = logCache.get(repo)!;
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
    const { mockThis, logCache, repo } = makeMock("105", {
      entries: [makeEntry("100")],
      revisionSet: new Set(["100"]),
      isComplete: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });

    await refresh.call(mockThis, undefined, false, true);

    const cached = logCache.get(repo)!;
    assert.strictEqual(
      cached.entries.length,
      0,
      "stale cache (e.g. post-commit) must clear so the view refetches"
    );
    assert.strictEqual(cached.isComplete, false);
    assert.strictEqual(cached.persisted.baseRevision, 105);
  });

  test("in-flight load disables the skip", async () => {
    const { mockThis, logCache, repo } = makeMock("105", {
      entries: [makeEntry("105")],
      revisionSet: new Set(["105"]),
      isComplete: false,
      isLoading: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });

    await refresh.call(mockThis, undefined, false, true);

    const cached = logCache.get(repo)!;
    assert.strictEqual(
      cached.entries.length,
      0,
      "partially loaded caches must not be preserved"
    );
  });

  test("hidden refresh performs no log fetch", async () => {
    const { mockThis, repo } = makeMock("105");
    mockThis.treeView.visible = false;

    await refresh.call(mockThis);

    assert.strictEqual(
      repo.log.mock.calls.length,
      0,
      "hidden history must defer network work until reveal"
    );
  });

  test("normal refresh drops history when the repository URL changes", async () => {
    const entries = [makeEntry("105")];
    const { mockThis, logCache, repo } = makeMock("100", {
      entries,
      revisionSet: new Set(["105"]),
      isComplete: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });
    const previous = logCache.get(repo);
    const branchUrl = "http://server/repo/branches/feature";
    repo.branchRoot = Uri.parse(branchUrl);

    await refresh.call(mockThis);

    const cached = logCache.get(repo)!;
    assert.notStrictEqual(cached, previous);
    assert.strictEqual(cached.entries.length, 0);
    assert.strictEqual(cached.svnTarget.toString(true), branchUrl);
  });

  test("explicit refresh cannot preserve entries from a previous URL", async () => {
    const { mockThis, logCache, repo } = makeMock("100", {
      entries: [makeEntry("105")],
      revisionSet: new Set(["105"]),
      isComplete: true,
      persisted: { commitFrom: "HEAD", baseRevision: 100 }
    });
    const branchUrl = "http://server/repo/branches/feature";
    repo.branchRoot = Uri.parse(branchUrl);

    await refresh.call(mockThis, undefined, false, true);

    const cached = logCache.get(repo)!;
    assert.strictEqual(cached.entries.length, 0);
    assert.strictEqual(cached.isComplete, false);
    assert.strictEqual(cached.svnTarget.toString(true), branchUrl);
  });

  test("load more invalidates the history root", async () => {
    const repo: any = {
      log: vi.fn().mockResolvedValue([makeEntry("99")])
    };
    const cached = {
      entries: [makeEntry("100")],
      revisionSet: new Set(["100"]),
      isComplete: false,
      repo,
      svnTarget: Uri.parse(REPO_URL),
      persisted: { commitFrom: "HEAD" }
    } as ICachedLog;
    const control = {
      kind: LogTreeItemKind.TItem,
      data: {} as any
    };
    const fire = vi.fn();
    const mockThis: any = {
      getCached: () => cached,
      _onDidChangeTreeData: { fire }
    };

    await refresh.call(mockThis, control, true, true);

    assert.deepStrictEqual(fire.mock.calls, [[undefined]]);
  });
});

suite("RepoLogProvider multi-root selection", () => {
  test("same-URL working copies keep independent caches", async () => {
    const branchRoot = { toString: () => REPO_URL };
    const makeRepo = (revision: string) => ({
      branchRoot,
      repository: { info: { revision } },
      clearLogCache: vi.fn(),
      log: vi.fn().mockResolvedValue([])
    });
    const repoA = makeRepo("101");
    const repoB = makeRepo("202");
    const mockThis: any = {
      logCache: new Map(),
      itemCaches: new WeakMap(),
      filterService: { getFilter: () => undefined },
      sourceControlManager: {
        repositories: [repoA, repoB],
        getRepositoryFromUri: () => repoA
      },
      treeView: { visible: true },
      _onDidChangeTreeData: { fire: vi.fn() },
      evictOldestLogEntry: () => {}
    };

    await refresh.call(mockThis);

    assert.strictEqual(mockThis.logCache.size, 2);
    const cached = (RepoLogProvider.prototype as any).getCached.call(mockThis);
    assert.strictEqual(cached.repo, repoA);
  });

  test("shows active editor owner, else first open repository", () => {
    const repoA = {
      branchRoot: { toString: () => "http://server/repo-a/trunk" }
    };
    const repoB = {
      branchRoot: { toString: () => "http://server/repo-b/trunk" }
    };
    const cacheFor = (repo: typeof repoA, revision: string): ICachedLog => ({
      entries: [makeEntry(revision)],
      revisionSet: new Set([revision]),
      isComplete: true,
      repo: repo as any,
      svnTarget: repo.branchRoot as any,
      persisted: { commitFrom: "HEAD" }
    });
    const logCache = new Map<object, ICachedLog>([
      [repoA, cacheFor(repoA, "101")],
      [repoB, cacheFor(repoB, "202")]
    ]);
    const mockThis: any = {
      logCache,
      itemCaches: new WeakMap(),
      getCached: (RepoLogProvider.prototype as any).getCached,
      filterService: {
        getFilter: () => undefined,
        hasActiveFilter: () => false
      },
      sourceControlManager: {
        repositories: [repoA, repoB],
        getRepositoryFromUri: () => repoB
      }
    };
    const previousEditor = window.activeTextEditor;
    try {
      (window as any).activeTextEditor = {
        document: { uri: Uri.file("/repo-b/file.ts") }
      };
      const active = RepoLogProvider.prototype.getChildren.call(
        mockThis,
        undefined
      );
      assert.strictEqual((active[0] as any).data.revision, "202");

      (window as any).activeTextEditor = undefined;
      const fallback = RepoLogProvider.prototype.getChildren.call(
        mockThis,
        undefined
      );
      assert.strictEqual((fallback[0] as any).data.revision, "101");
    } finally {
      (window as any).activeTextEditor = previousEditor;
    }
  });

  test("rendered commit retains its repository after editor switch", () => {
    const repoA = {
      branchRoot: { toString: () => "http://server/repo-a/trunk" }
    };
    const repoB = {
      branchRoot: { toString: () => "http://server/repo-b/trunk" }
    };
    const cachedA = {
      entries: [makeEntry("101")],
      revisionSet: new Set(["101"]),
      isComplete: true,
      repo: repoA,
      svnTarget: repoA.branchRoot,
      persisted: { commitFrom: "HEAD" }
    } as ICachedLog;
    const cachedB = {
      ...cachedA,
      entries: [makeEntry("202")],
      revisionSet: new Set(["202"]),
      repo: repoB,
      svnTarget: repoB.branchRoot
    } as ICachedLog;
    const owner = vi.fn(() => repoA);
    const mockThis: any = {
      logCache: new Map([[repoA, cachedA]]),
      itemCaches: new WeakMap(),
      getCached: (RepoLogProvider.prototype as any).getCached,
      filterService: {
        getFilter: () => undefined,
        hasActiveFilter: () => false
      },
      sourceControlManager: {
        repositories: [repoA, repoB],
        getRepositoryFromUri: owner
      }
    };
    const previousEditor = window.activeTextEditor;
    try {
      (window as any).activeTextEditor = {
        document: { uri: Uri.file("/repo-a/file.ts") }
      };
      const [commit] = RepoLogProvider.prototype.getChildren.call(
        mockThis,
        undefined
      );
      owner.mockReturnValue(repoB);
      mockThis.logCache = new Map([
        [repoB, cachedB],
        [repoA, cachedA]
      ]);

      const cached = (RepoLogProvider.prototype as any).getCached.call(
        mockThis,
        commit
      );
      assert.strictEqual(cached.repo, repoA);
    } finally {
      (window as any).activeTextEditor = previousEditor;
    }
  });

  test("rendered load controls retain their repository", () => {
    const repoA = {
      branchRoot: { toString: () => "http://server/repo-a/trunk" }
    };
    const repoB = {
      branchRoot: { toString: () => "http://server/repo-b/trunk" }
    };
    const cacheFor = (repo: typeof repoA, revision: string): ICachedLog => ({
      entries: [makeEntry(revision)],
      revisionSet: new Set([revision]),
      isComplete: false,
      repo: repo as any,
      svnTarget: repo.branchRoot as any,
      persisted: { commitFrom: "HEAD" }
    });
    const cachedA = cacheFor(repoA, "101");
    const cachedB = cacheFor(repoB, "202");
    const owner = vi.fn(() => repoA);
    const mockThis: any = {
      logCache: new Map([
        [repoA, cachedA],
        [repoB, cachedB]
      ]),
      itemCaches: new WeakMap(),
      getCached: (RepoLogProvider.prototype as any).getCached,
      filterService: {
        getFilter: () => undefined,
        hasActiveFilter: () => false
      },
      sourceControlManager: {
        repositories: [repoA, repoB],
        getRepositoryFromUri: owner
      }
    };

    const previousEditor = window.activeTextEditor;
    try {
      (window as any).activeTextEditor = {
        document: { uri: Uri.file("/repo-a/file.ts") }
      };
      const items = RepoLogProvider.prototype.getChildren.call(
        mockThis,
        undefined
      );
      const controls = items.filter((item: any) => item.data.command);
      owner.mockReturnValue(repoB);
      (window as any).activeTextEditor = {
        document: { uri: Uri.file("/repo-b/file.ts") }
      };

      assert.strictEqual(controls.length, 2);
      for (const control of controls) {
        if (control.kind !== LogTreeItemKind.TItem) {
          assert.fail("expected history control");
        }
        const args = control.data.command?.arguments;
        if (!args) assert.fail("expected history command arguments");
        const commandItem = args[0];
        assert.strictEqual(commandItem, control);
        const cached = (RepoLogProvider.prototype as any).getCached.call(
          mockThis,
          commandItem
        );
        assert.strictEqual(cached.repo, repoA);
      }
    } finally {
      (window as any).activeTextEditor = previousEditor;
    }
  });

  test("synthetic BASE item retains its repository", async () => {
    const cached = {
      entries: [makeEntry("101")],
      revisionSet: new Set(["101"]),
      isComplete: true,
      repo: {},
      svnTarget: { toString: () => REPO_URL },
      persisted: { commitFrom: "HEAD", baseRevision: 101 }
    } as ICachedLog;
    const reveal = vi.fn().mockResolvedValue(undefined);
    const itemCaches = new WeakMap();
    const mockThis: any = {
      treeView: { reveal },
      getCached: () => cached,
      itemCaches
    };

    await RepoLogProvider.prototype.goToBase.call(mockThis);

    const item = reveal.mock.calls[0]![0];
    assert.strictEqual(itemCaches.get(item), cached);
  });

  test("revealing a hidden stale view refreshes metadata", () => {
    const refreshView = vi.fn();
    const mockThis: any = {
      pendingExplicitRefresh: false,
      pendingRefresh: true,
      refresh: refreshView
    };

    (RepoLogProvider.prototype as any).onVisibilityChanged.call(mockThis, true);

    assert.strictEqual(refreshView.mock.calls.length, 1);
  });

  test("active editor changes invalidate the displayed root", () => {
    const repo = {};
    const fire = vi.fn();
    const handler = (RepoLogProvider.prototype as any).onActiveEditorChanged;

    assert.strictEqual(typeof handler, "function");
    handler.call(
      {
        sourceControlManager: {
          repositories: [repo],
          getRepositoryFromUri: () => repo
        },
        selectedOwner: {},
        _onDidChangeTreeData: { fire }
      },
      { document: { uri: Uri.file("/repo/file.ts") } }
    );
    assert.strictEqual(fire.mock.calls.length, 1);
  });

  test("same-repository editor changes do not invalidate the root", () => {
    const repo = {};
    const fire = vi.fn();
    const handler = (RepoLogProvider.prototype as any).onActiveEditorChanged;
    const mockThis: any = {
      sourceControlManager: {
        repositories: [repo],
        getRepositoryFromUri: () => repo
      },
      _onDidChangeTreeData: { fire }
    };

    handler.call(mockThis, {
      document: { uri: Uri.file("/repo/file-a.ts") }
    });
    fire.mockClear();
    handler.call(mockThis, {
      document: { uri: Uri.file("/repo/file-b.ts") }
    });

    assert.strictEqual(fire.mock.calls.length, 0);
  });

  test("revision lookup does not reveal after the displayed owner changes", async () => {
    let releasePage!: (entries: ISvnLogEntry[]) => void;
    let markStarted!: () => void;
    const page = new Promise<ISvnLogEntry[]>(resolve => {
      releasePage = resolve;
    });
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const repoA: any = {
      branchRoot: Uri.parse("http://server/repo-a/trunk"),
      log: vi.fn(() => {
        markStarted();
        return page;
      })
    };
    const repoB: any = {
      branchRoot: Uri.parse("http://server/repo-b/trunk")
    };
    const cachedA = {
      entries: [makeEntry("100")],
      revisionSet: new Set(["100"]),
      isComplete: false,
      repo: repoA,
      svnTarget: repoA.branchRoot,
      persisted: { commitFrom: "HEAD" }
    } as ICachedLog;
    const cachedB = {
      entries: [makeEntry("60")],
      revisionSet: new Set(["60"]),
      isComplete: true,
      repo: repoB,
      svnTarget: repoB.branchRoot,
      persisted: { commitFrom: "HEAD" }
    } as ICachedLog;
    const reveal = vi.fn().mockResolvedValue(undefined);
    const fire = vi.fn();
    const ownerFor = (uri: Uri) =>
      uri.fsPath.includes("repo-b") ? repoB : repoA;
    const mockThis: any = {
      treeView: { reveal },
      logCache: new Map([
        [repoA, cachedA],
        [repoB, cachedB]
      ]),
      itemCaches: new WeakMap(),
      getCached: (RepoLogProvider.prototype as any).getCached,
      filterService: { hasActiveFilter: () => false },
      sourceControlManager: {
        repositories: [repoA, repoB],
        getRepositoryFromUri: ownerFor
      },
      _onDidChangeTreeData: { fire }
    };
    const handler = (RepoLogProvider.prototype as any).onActiveEditorChanged;
    const previousEditor = window.activeTextEditor;
    const withProgress = window.withProgress as any;
    const previousProgress = withProgress.getMockImplementation();
    withProgress.mockImplementation((_options: any, task: any) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => undefined })
        }
      )
    );
    try {
      const editorA = {
        document: { uri: Uri.file("/repo-a/file.ts") }
      };
      (window as any).activeTextEditor = editorA;
      handler.call(mockThis, editorA);

      const navigation = RepoLogProvider.prototype.goToRevision.call(
        mockThis,
        50
      );
      await started;

      const editorB = {
        document: { uri: Uri.file("/repo-b/file.ts") }
      };
      (window as any).activeTextEditor = editorB;
      handler.call(mockThis, editorB);
      releasePage([makeEntry("50")]);
      await navigation;

      assert.strictEqual(reveal.mock.calls.length, 0);
    } finally {
      releasePage([]);
      withProgress.mockImplementation(previousProgress);
      (window as any).activeTextEditor = previousEditor;
    }
  });

  test("same revision in different repositories has distinct tree ids", () => {
    const branchRoot = Uri.parse(REPO_URL);
    const repoA = { branchRoot, workspaceRoot: "/repo-a" };
    const repoB = { branchRoot, workspaceRoot: "/repo-b" };
    const cacheFor = (repo: typeof repoA): ICachedLog => ({
      entries: [makeEntry("101")],
      revisionSet: new Set(["101"]),
      isComplete: true,
      repo: repo as any,
      svnTarget: branchRoot,
      persisted: { commitFrom: "HEAD" }
    });
    const cachedA = cacheFor(repoA);
    const cachedB = cacheFor(repoB);
    const itemA = {
      kind: LogTreeItemKind.Commit,
      data: makeEntry("101")
    } as const;
    const itemB = {
      kind: LogTreeItemKind.Commit,
      data: makeEntry("101")
    } as const;
    const itemCaches = new WeakMap();
    itemCaches.set(itemA, cachedA);
    itemCaches.set(itemB, cachedB);
    const mockThis: any = {
      logCache: new Map([
        [repoA, cachedA],
        [repoB, cachedB]
      ]),
      itemCaches,
      getCached: (RepoLogProvider.prototype as any).getCached
    };

    const treeA = RepoLogProvider.prototype.getTreeItem.call(
      mockThis,
      itemA as any
    );
    const treeB = RepoLogProvider.prototype.getTreeItem.call(
      mockThis,
      itemB as any
    );

    assert.ok(treeA.id);
    assert.ok(treeB.id);
    assert.notStrictEqual(treeA.id, treeB.id);
  });
});
