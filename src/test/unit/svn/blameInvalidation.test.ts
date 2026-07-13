import * as assert from "assert";
import { Operation, RepositoryState } from "../../../common/types";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

suite("Blame cache invalidation on mutating operations", () => {
  test("clearBlameCache drops blame results and cached errors", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();

    await repo.blame("file.txt");
    repo._blameErrorCache.set("bad.bin@BASE", "Cannot blame binary file");

    repo.clearBlameCache();

    assert.strictEqual(repo._blameCache.get("file.txt@BASE"), undefined);
    assert.strictEqual(repo._blameErrorCache.get("bad.bin@BASE"), undefined);

    await repo.blame("file.txt");
    assert.strictEqual(getCount(), 2, "post-clear blame must re-fetch");
    assert.ok(
      repo._blameCache.get("file.txt@BASE") !== undefined,
      "post-clear fetch must repopulate the cache (generation matches)"
    );
  });

  test("switchBranch clears the blame cache", async () => {
    const { repo } = await makeFakeSvnRepo();

    await repo.blame("file.txt");
    assert.ok(repo._blameCache.get("file.txt@BASE") !== undefined);

    await repo.switchBranch("branches/x");

    assert.strictEqual(
      repo._blameCache.get("file.txt@BASE"),
      undefined,
      "switch changes BASE content - blame cache must be dropped"
    );
  });

  test("dispose-path clear also blocks in-flight write-back", async () => {
    const { BLAME_XML } = await import("./helpers/fakeSvnRepository");
    const { repo, setExec } = await makeFakeSvnRepo();

    let release!: () => void;
    setExec(
      () =>
        new Promise(resolve => {
          release = () => resolve({ stdout: BLAME_XML });
        })
    );
    const pending = repo.blame("file.txt");
    await new Promise(r => setTimeout(r, 10));

    repo.clearInfoCacheTimers(); // repository disposal path

    release();
    await pending;

    assert.strictEqual(
      repo._blameCache.get("file.txt@BASE"),
      undefined,
      "in-flight fetch must not repopulate caches of a disposed repository"
    );
  });

  test("Repository.run clears blame cache on force-refresh ops", async () => {
    const { Repository } = await import("../../../repository");

    let cleared = 0;
    const mockThis: any = {
      state: RepositoryState.Idle,
      repository: {
        clearBlameCache: () => {
          cleared++;
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async () => {},
      lastForceRefresh: 0
    };

    const run = (Repository.prototype as any).run;
    await run.call(mockThis, Operation.Commit, async () => "ok");
    assert.strictEqual(cleared, 1, "commit must clear the blame cache");

    await run.call(mockThis, Operation.Blame, async () => "ok");
    assert.strictEqual(cleared, 1, "read-only ops must not clear it");
  });

  test("Repository.run clears caches BEFORE the post-op status refresh", async () => {
    const { Repository } = await import("../../../repository");

    const order: string[] = [];
    const mockThis: any = {
      state: RepositoryState.Idle,
      repository: {
        clearBlameCache: () => order.push("clear")
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => order.push("event") },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async () => {
        order.push("status");
      },
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    const run = (Repository.prototype as any).run;
    await run.call(mockThis, Operation.Update, async () => "ok");
    assert.deepStrictEqual(
      order,
      ["clear", "status", "event"],
      "clear must precede updateModelState so its seeded info cache survives"
    );
  });

  test("Repository.run reports pre/post external roots for a switch", async () => {
    const { Repository } = await import("../../../repository");
    const details: any[] = [];
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot: process.cwd(),
      externalWorkingCopyRoots: ["old-external"],
      repository: { clearBlameCache: () => {} },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: { fire: (detail: any) => details.push(detail) },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async () => {
        mockThis.externalWorkingCopyRoots = ["new-external"];
      },
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    const run = (Repository.prototype as any).run;
    await run.call(mockThis, Operation.SwitchBranch, async () => "ok", {
      externalImpact: { traverseExternals: true }
    });

    assert.deepStrictEqual(details[0]?.affectedExternalRoots.sort(), [
      "new-external",
      "old-external"
    ]);
  });

  test("update variants report their exact external traversal scope", async () => {
    const { Repository } = await import("../../../repository");
    const impacts: any[] = [];
    const mockThis: any = {
      run: async (
        _op: Operation,
        fn: () => Promise<unknown>,
        options?: any
      ) => {
        impacts.push(options?.externalImpact);
        return fn();
      },
      repository: {
        update: async () => ({ revision: null, conflicts: [], message: "" }),
        pullIncomingChange: async () => "ok",
        setDepth: async () => "ok"
      },
      updateRemoteChangedFiles: () => {},
      _lastRemoteCheck: undefined
    };

    await (Repository.prototype as any).updateRevision.call(mockThis, false, {
      skipHistoryRefresh: true
    });
    await (Repository.prototype as any).updateRevision.call(mockThis, true, {
      skipHistoryRefresh: true
    });
    await (Repository.prototype as any).updateRevision.call(mockThis, false, {
      skipHistoryRefresh: true,
      files: ["src/file.ts"]
    });
    await (Repository.prototype as any).pullIncomingChange.call(
      mockThis,
      "src/file.ts"
    );
    await (Repository.prototype as any).setDepth.call(
      mockThis,
      "vendor",
      "infinity"
    );

    assert.deepStrictEqual(impacts, [
      { traverseExternals: true },
      { traverseExternals: false },
      { traverseExternals: true, targets: ["src/file.ts"] },
      { traverseExternals: false, targets: ["src/file.ts"] },
      { traverseExternals: true, targets: ["vendor"] }
    ]);
  });

  test("branch switches report full external traversal", async () => {
    const { Repository } = await import("../../../repository");
    const impacts: any[] = [];
    const mockThis: any = {
      run: async (
        _op: Operation,
        fn: () => Promise<unknown>,
        options?: any
      ) => {
        impacts.push(options?.externalImpact);
        return fn();
      },
      repository: {
        switchBranch: async () => undefined,
        newBranch: async () => undefined,
        finishCheckout: async () => undefined
      },
      updateRemoteChangedFiles: () => {}
    };

    await (Repository.prototype as any).switchBranch.call(mockThis, "trunk");
    await (Repository.prototype as any).newBranch.call(mockThis, "feature");
    await (Repository.prototype as any).finishCheckout.call(mockThis);

    assert.deepStrictEqual(impacts, [
      { traverseExternals: true },
      { traverseExternals: true },
      { traverseExternals: true }
    ]);
  });

  test("Repository.run still clears caches when the operation fails", async () => {
    const { Repository } = await import("../../../repository");

    let cleared = 0;
    const details: any[] = [];
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot: process.cwd(),
      externalWorkingCopyRoots: ["external"],
      repository: {
        clearBlameCache: () => {
          cleared++;
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: { fire: (detail: any) => details.push(detail) },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async () => {},
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    const run = (Repository.prototype as any).run;
    await assert.rejects(
      run.call(
        mockThis,
        Operation.Update,
        async () => {
          throw new Error("E170013 connection refused");
        },
        { externalImpact: { traverseExternals: true } }
      )
    );
    assert.strictEqual(
      cleared,
      1,
      "a failed update may have partially mutated the WC - caches must drop"
    );
    assert.deepStrictEqual(details[0]?.affectedExternalRoots, ["external"]);
  });
});
