import * as assert from "assert";
import * as path from "path";
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

  test("Repository.run snapshots nested externals before a switch removes them", async () => {
    const { Repository } = await import("../../../repository");
    const details: any[] = [];
    const order: string[] = [];
    const refreshArgs: unknown[][] = [];
    const workspaceRoot = process.cwd();
    const externalRoot = path.join(workspaceRoot, "external");
    const nestedRoot = path.join(externalRoot, "nested");
    let topologyRead = 0;
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [externalRoot],
      repository: {
        clearBlameCache: () => {},
        getStatus: async (options: unknown) => {
          order.push(
            topologyRead++ === 0 ? "topology-before" : "topology-after"
          );
          assert.deepStrictEqual(options, {
            includeIgnored: false,
            includeExternals: true,
            checkRemoteChanges: false,
            fetchLockStatus: false,
            fetchExternalUuids: false
          });
          return topologyRead === 1
            ? [
                { status: "external", path: "external" },
                { status: "external", path: "external/nested" }
              ]
            : [{ status: "external", path: "external" }];
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: {
        fire: (detail: any) => {
          order.push("detail");
          details.push(detail);
        }
      },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async (...args: unknown[]) => {
        order.push("refresh");
        refreshArgs.push(args);
      },
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    const run = (Repository.prototype as any).run;
    await run.call(
      mockThis,
      Operation.SwitchBranch,
      async () => {
        order.push("mutation");
        return "ok";
      },
      { externalImpact: { traverseExternals: true } }
    );

    assert.deepStrictEqual(details[0]?.affectedExternalRoots.sort(), [
      externalRoot,
      nestedRoot
    ]);
    assert.deepStrictEqual(refreshArgs, [[false, true, false]]);
    assert.deepStrictEqual(order, [
      "topology-before",
      "mutation",
      "refresh",
      "topology-after",
      "detail"
    ]);
  });

  test("Repository.run keeps successful scoped topology reads", async () => {
    const { Repository } = await import("../../../repository");
    const details: any[] = [];
    const refreshArgs: unknown[][] = [];
    const workspaceRoot = process.cwd();
    const target = path.join(workspaceRoot, "vendor");
    const nestedRoot = path.join(target, "nested");
    const topologyReads: string[] = [];
    let operationRan = false;
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getStatus: async () => {
          throw new Error("must not scan the whole working copy");
        },
        getScopedStatus: async (actualTarget: string, depth: string) => {
          assert.strictEqual(depth, "infinity");
          topologyReads.push(actualTarget);
          if (actualTarget.endsWith("broken")) {
            throw new Error("unrelated broken external");
          }
          return [{ status: "external", path: "vendor/nested" }];
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: { fire: (detail: any) => details.push(detail) },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async (...args: unknown[]) => {
        refreshArgs.push(args);
      },
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    const run = (Repository.prototype as any).run;
    const result = await run.call(
      mockThis,
      Operation.Update,
      async () => {
        operationRan = true;
        return "ok";
      },
      {
        externalImpact: {
          traverseExternals: true,
          targets: ["vendor", "broken"]
        }
      }
    );

    assert.strictEqual(result, "ok");
    assert.strictEqual(operationRan, true);
    assert.deepStrictEqual(topologyReads.sort(), [
      path.join(workspaceRoot, "broken"),
      path.join(workspaceRoot, "broken"),
      target,
      target
    ]);
    assert.deepStrictEqual(refreshArgs, [[false, true, false]]);
    assert.deepStrictEqual(details[0]?.affectedExternalRoots, [nestedRoot]);
  });

  test("Repository.run deduplicates Windows case-alias targets", async () => {
    if (process.platform !== "win32") return;

    const { Repository } = await import("../../../repository");
    const details: any[] = [];
    const workspaceRoot = process.cwd();
    const target = path.join(workspaceRoot, "vendor");
    let topologyReads = 0;
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getScopedStatus: async () => {
          topologyReads++;
          return [{ status: "external", path: "vendor/nested" }];
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

    await (Repository.prototype as any).run.call(
      mockThis,
      Operation.Update,
      async () => "ok",
      {
        externalImpact: {
          traverseExternals: true,
          targets: [target, target.toUpperCase()]
        }
      }
    );

    assert.strictEqual(topologyReads, 2, "one scoped read before and after");
    assert.deepStrictEqual(details[0]?.affectedExternalRoots, [
      path.join(target, "nested")
    ]);
  });

  test("Repository.run bounds topology reads for large target sets", async () => {
    const { Repository } = await import("../../../repository");
    const workspaceRoot = process.cwd();
    const targets = Array.from(
      { length: 20 },
      (_, index) => `missing-topology-target-${index}`
    );
    let rootReads = 0;
    let scopedReads = 0;
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getStatus: async () => {
          rootReads++;
          return [];
        },
        getScopedStatus: async () => {
          scopedReads++;
          return [];
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: { fire: () => {} },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async () => {},
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    await (Repository.prototype as any).run.call(
      mockThis,
      Operation.Update,
      async () => "ok",
      { externalImpact: { traverseExternals: true, targets } }
    );

    assert.strictEqual(rootReads, 2, "one bounded read before and after");
    assert.strictEqual(scopedReads, 0);
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
      { traverseExternals: true, targets: ["src/file.ts"] },
      { traverseExternals: true, targets: ["vendor"] }
    ]);
  });

  test("pullIncomingChange preserves SVN external traversal", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const calls: string[][] = [];
    const mockThis: any = {
      exec: async (args: string[]) => {
        calls.push(args);
        return { stdout: "Updated to revision 2." };
      },
      resetInfoCache: () => {}
    };

    await SvnRepository.prototype.pullIncomingChange.call(
      mockThis,
      "vendor/file.ts"
    );

    assert.deepStrictEqual(calls, [["update", "vendor/file.ts"]]);
  });

  test("commits report explicit targets for cross-WC invalidation", async () => {
    const { Repository } = await import("../../../repository");
    const impacts: any[] = [];
    const mockThis: any = {
      needsLockCacheExpiry: Number.POSITIVE_INFINITY,
      hasNeedsLock: async () => false,
      run: async (
        _op: Operation,
        fn: () => Promise<unknown>,
        options?: any
      ) => {
        impacts.push(options?.externalImpact);
        return fn();
      },
      repository: {
        commitFiles: async () => "ok",
        updateInfo: async () => undefined
      },
      updateRevision: async () => undefined
    };

    await (Repository.prototype as any).commitFiles.call(mockThis, "message", [
      "/wc/external/file.ts"
    ]);

    assert.deepStrictEqual(impacts, [
      {
        traverseExternals: false,
        targets: ["/wc/external/file.ts"]
      }
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
