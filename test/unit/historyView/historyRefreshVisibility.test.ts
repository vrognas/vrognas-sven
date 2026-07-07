import { describe, it, expect, vi } from "vitest";

type Harness = {
  treeView: { visible: boolean };
  refresh: ReturnType<typeof vi.fn>;
  editorChanged?: ReturnType<typeof vi.fn>;
  pendingExplicitRefresh?: boolean;
  sourceControlManager?: { repositories: { clearLogCache: () => void }[] };
};

type ProviderProto = {
  explicitRefreshCmd: (this: Harness, ...args: unknown[]) => Promise<void>;
  onVisibilityChanged: (this: Harness, visible: boolean) => void;
};

function proto(providerClass: { prototype: unknown }): ProviderProto {
  return providerClass.prototype as ProviderProto;
}

/**
 * Post-commit/update flows fire `sven.repolog.fetch` + `sven.itemlog.refresh`,
 * which used to clear caches and issue fresh `svn log` server calls even
 * when the history panels were hidden (the common case). The explicit
 * refresh must defer while hidden and run once on reveal.
 */
describe("History refresh visibility gating", () => {
  it("repoLog: explicit refresh while hidden defers; reveal runs it once", async () => {
    const { RepoLogProvider } = await import(
      "../../../src/historyView/repoLogProvider"
    );
    const refresh = vi.fn(async () => undefined);
    const mockThis: Harness = {
      treeView: { visible: false },
      refresh,
      sourceControlManager: { repositories: [] }
    };

    const { explicitRefreshCmd, onVisibilityChanged } = proto(RepoLogProvider);
    await explicitRefreshCmd.call(mockThis);
    expect(refresh).not.toHaveBeenCalled();

    mockThis.treeView.visible = true;
    onVisibilityChanged.call(mockThis, true);
    expect(refresh).toHaveBeenCalledTimes(1);
    // the deferred refresh must be the cache-clearing kind
    expect(refresh.mock.calls[0]![2]).toBe(true);

    // no pending refresh left - next reveal is free
    onVisibilityChanged.call(mockThis, true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("repoLog: explicit refresh while visible runs immediately", async () => {
    const { RepoLogProvider } = await import(
      "../../../src/historyView/repoLogProvider"
    );
    const refresh = vi.fn(async () => undefined);
    const mockThis: Harness = {
      treeView: { visible: true },
      refresh
    };

    await proto(RepoLogProvider).explicitRefreshCmd.call(mockThis);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("hidden defer still clears the low-level log cache (post-commit invariant)", async () => {
    const { RepoLogProvider } = await import(
      "../../../src/historyView/repoLogProvider"
    );
    const clearLogCache = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const mockThis: Harness = {
      treeView: { visible: false },
      refresh,
      sourceControlManager: { repositories: [{ clearLogCache }] }
    };

    await proto(RepoLogProvider).explicitRefreshCmd.call(mockThis);

    expect(refresh).not.toHaveBeenCalled();
    expect(clearLogCache).toHaveBeenCalledTimes(1);
  });

  it("repoLog: load-more click bypasses the hidden defer", async () => {
    const { RepoLogProvider } = await import(
      "../../../src/historyView/repoLogProvider"
    );
    const refresh = vi.fn(async () => undefined);
    const mockThis: Harness = {
      treeView: { visible: false },
      refresh
    };

    await proto(RepoLogProvider).explicitRefreshCmd.call(
      mockThis,
      undefined,
      true // fetchMoreClick
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("itemLog: load-more pages older history instead of resetting", async () => {
    const { ItemLogProvider } = await import(
      "../../../src/historyView/itemLogProvider"
    );
    const refresh = vi.fn(async () => undefined);
    const element = { kind: 1 };
    const mockThis: Harness = {
      treeView: { visible: true },
      refresh
    };

    // createLoadMoreItem("sven.itemlog.refresh", [element, undefined, true])
    await proto(ItemLogProvider).explicitRefreshCmd.call(
      mockThis,
      element,
      undefined,
      true
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toBe(element);
    expect(refresh.mock.calls[0]![2]).toBe(true); // loadMore
    expect(refresh.mock.calls[0]![3]).not.toBe(true); // not cache-clearing
  });

  it("itemLog: explicit refresh while hidden defers; reveal runs it once", async () => {
    const { ItemLogProvider } = await import(
      "../../../src/historyView/itemLogProvider"
    );
    const refresh = vi.fn(async () => undefined);
    const mockThis: Harness = {
      treeView: { visible: false },
      refresh,
      editorChanged: vi.fn(),
      sourceControlManager: { repositories: [] }
    };

    const { explicitRefreshCmd, onVisibilityChanged } = proto(ItemLogProvider);
    await explicitRefreshCmd.call(mockThis);
    expect(refresh).not.toHaveBeenCalled();

    mockThis.treeView.visible = true;
    onVisibilityChanged.call(mockThis, true);
    expect(refresh).toHaveBeenCalledTimes(1);
    // explicitRefresh flag position: refresh(element, te, loadMore, explicit)
    expect(refresh.mock.calls[0]![3]).toBe(true);
  });
});
