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

  test("Repository.run preserves partial roots from failed full topology scans", async () => {
    const { Repository } = await import("../../../repository");
    const workspaceRoot = process.cwd();
    const details: any[] = [];
    let operationRan = false;
    const statusXml = (externalPath: string) =>
      `<?xml version="1.0"?><status><target path="."><entry path="${externalPath}"><wc-status item="external" props="none"/></entry></target></status>`;
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getStatus: async () => {
          throw Object.assign(new Error("broken sibling external"), {
            stdout: statusXml(operationRan ? "new-external" : "old-external")
          });
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
      Operation.SwitchBranch,
      async () => {
        operationRan = true;
        return "ok";
      },
      { externalImpact: { traverseExternals: true } }
    );

    assert.deepStrictEqual(details[0]?.affectedExternalRoots.sort(), [
      path.join(workspaceRoot, "new-external"),
      path.join(workspaceRoot, "old-external")
    ]);
    assert.strictEqual(details[0]?.externalTopologyIncomplete, true);
  });

  test("Repository.run keeps successful scoped topology reads", async () => {
    const { Repository } = await import("../../../repository");
    const details: any[] = [];
    const refreshArgs: unknown[][] = [];
    const workspaceRoot = process.cwd();
    const target = path.join(workspaceRoot, "vendor");
    const nestedRoot = path.join(target, "nested");
    const topologyReads: string[] = [];
    let batchReads = 0;
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
        getScopedStatus: async (
          actualTarget: string | readonly string[],
          depth: string
        ) => {
          assert.strictEqual(depth, "infinity");
          const actualTargets =
            typeof actualTarget === "string"
              ? [actualTarget]
              : [...actualTarget];
          if (actualTargets.length > 1) {
            batchReads++;
          } else {
            topologyReads.push(actualTargets[0]!);
          }
          if (actualTargets.some(value => value.endsWith("broken"))) {
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
    assert.strictEqual(batchReads, 2);
    assert.deepStrictEqual(topologyReads.sort(), [
      path.join(workspaceRoot, "broken"),
      path.join(workspaceRoot, "broken"),
      target,
      target
    ]);
    assert.deepStrictEqual(refreshArgs, [[false, true, false]]);
    assert.deepStrictEqual(details[0]?.affectedExternalRoots, [nestedRoot]);
  });

  test("Repository.run marks failed targeted topology incomplete", async () => {
    const { Repository } = await import("../../../repository");
    const details: any[] = [];
    const workspaceRoot = process.cwd();
    const target = path.join(workspaceRoot, "vendor");
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getScopedStatus: async () => {
          throw new Error("broken nested external");
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
          targets: [target]
        }
      }
    );

    assert.strictEqual(details[0]?.externalTopologyIncomplete, true);
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
    const details: any[] = [];
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
          return [{ status: "external", path: "unrelated-external" }];
        },
        getScopedStatus: async () => {
          scopedReads++;
          return [];
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
      { externalImpact: { traverseExternals: true, targets } }
    );

    assert.strictEqual(rootReads, 2, "one bounded read before and after");
    assert.strictEqual(scopedReads, 0);
    assert.deepStrictEqual(
      details[0]?.affectedExternalRoots,
      [],
      "fallback discovery must not widen targeted invalidation"
    );
  });

  test("Repository.run falls back to bounded scopes after root scan failure", async () => {
    const { Repository } = await import("../../../repository");
    const workspaceRoot = process.cwd();
    const details: any[] = [];
    const targets = Array.from(
      { length: 20 },
      (_, index) => `missing-fallback-target-${index}`
    );
    let rootReads = 0;
    let scopedReads = 0;
    const scopedTargets: string[] = [];
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getStatus: async () => {
          rootReads++;
          throw new Error("unrelated broken external");
        },
        getScopedStatus: async (target: string | readonly string[]) => {
          scopedReads++;
          const batch = typeof target === "string" ? [target] : [...target];
          scopedTargets.push(...batch);
          return batch.some(value => value.endsWith("-19"))
            ? [
                {
                  status: "external",
                  path: "missing-fallback-target-19/nested"
                }
              ]
            : [];
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
      { externalImpact: { traverseExternals: true, targets } }
    );

    assert.strictEqual(rootReads, 2);
    assert.strictEqual(
      scopedReads,
      4,
      "twenty targets should use two bounded batches per snapshot"
    );
    assert.strictEqual(
      scopedTargets.filter(value => value.endsWith("-19")).length,
      2,
      "late targets must be covered before and after mutation"
    );
    assert.deepStrictEqual(details[0]?.affectedExternalRoots, [
      path.join(workspaceRoot, "missing-fallback-target-19", "nested")
    ]);
  });

  test("Repository.run retries transient topology reads", async () => {
    const { Repository } = await import("../../../repository");
    const workspaceRoot = process.cwd();
    const details: any[] = [];
    const targets = Array.from(
      { length: 20 },
      (_, index) => `missing-retry-target-${index}`
    );
    const externalPath = "missing-retry-target-0/nested";
    let operationRan = false;
    let rootReads = 0;
    let topologyRetries = 0;
    const locked = Object.assign(new Error("working copy locked"), {
      svnErrorCode: "E155004"
    });
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getStatus: async () => {
          rootReads++;
          if (operationRan) return [];
          if (rootReads === 1) throw locked;
          return [{ status: "external", path: externalPath }];
        },
        getScopedStatus: async () => {
          throw locked;
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: { fire: (detail: any) => details.push(detail) },
      retryRun: async (fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch {
          topologyRetries++;
          return fn();
        }
      },
      updateModelState: async () => {},
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    await (Repository.prototype as any).run.call(
      mockThis,
      Operation.Update,
      async () => {
        operationRan = true;
        return "ok";
      },
      { externalImpact: { traverseExternals: true, targets } }
    );

    assert.strictEqual(topologyRetries, 1);
    assert.strictEqual(rootReads, 3);
    assert.deepStrictEqual(details[0]?.affectedExternalRoots, [
      path.join(workspaceRoot, externalPath)
    ]);
  });

  test("Repository.run unions partial roots across topology retries", async () => {
    const { Repository } = await import("../../../repository");
    const workspaceRoot = process.cwd();
    const details: any[] = [];
    const targets = Array.from(
      { length: 20 },
      (_, index) => `missing-partial-target-${index}`
    );
    const externalPath = "missing-partial-target-0/nested";
    let operationRan = false;
    let attempt = 0;
    const locked = Object.assign(new Error("working copy locked"), {
      svnErrorCode: "E155004"
    });
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getStatus: async () => {
          if (operationRan) return [];
          throw new Error("unrelated broken external");
        },
        getScopedStatus: async (target: string | readonly string[]) => {
          const batch = typeof target === "string" ? [target] : [...target];
          if (attempt === 1 && batch.some(value => value.endsWith("-0"))) {
            return [{ status: "external", path: externalPath }];
          }
          throw locked;
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: { fire: (detail: any) => details.push(detail) },
      retryRun: async (fn: () => Promise<unknown>) => {
        attempt = 1;
        try {
          return await fn();
        } catch {
          attempt = 2;
          return fn();
        }
      },
      updateModelState: async () => {},
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    await (Repository.prototype as any).run.call(
      mockThis,
      Operation.Update,
      async () => {
        operationRan = true;
        return "ok";
      },
      { externalImpact: { traverseExternals: true, targets } }
    );

    assert.deepStrictEqual(details[0]?.affectedExternalRoots, [
      path.join(workspaceRoot, externalPath)
    ]);
  });

  test("Repository.run awaits a failed topology batch before retry", async () => {
    const { Repository } = await import("../../../repository");
    const workspaceRoot = process.cwd();
    const targets = Array.from(
      { length: 20 },
      (_, index) => `missing-overlap-target-${index}`
    );
    let operationRan = false;
    let topologyRetries = 0;
    let active = 0;
    let maxActive = 0;
    let releaseSlow!: () => void;
    const slow = new Promise<void>(resolve => (releaseSlow = resolve));
    let markFirstBatchStarted!: () => void;
    const firstBatchStarted = new Promise<void>(
      resolve => (markFirstBatchStarted = resolve)
    );
    const locked = Object.assign(new Error("working copy locked"), {
      svnErrorCode: "E155004"
    });
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot,
      externalWorkingCopyRoots: [],
      repository: {
        clearBlameCache: () => {},
        getStatus: async () => {
          if (operationRan) return [];
          throw new Error("unrelated broken external");
        },
        getScopedStatus: async (target: string | readonly string[]) => {
          if (typeof target !== "string") throw locked;
          active++;
          maxActive = Math.max(maxActive, active);
          const index = Number(target.match(/(\d+)$/)?.[1]);
          if (index % 16 === 0) {
            active--;
            throw locked;
          }
          if (active === 15) markFirstBatchStarted();
          try {
            await slow;
          } finally {
            active--;
          }
          throw locked;
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      _onDidRunOperationDetail: { fire: () => {} },
      retryRun: async (fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch {
          topologyRetries++;
          return fn();
        }
      },
      updateModelState: async () => {},
      lastForceRefresh: 0,
      _changesGeneration: 0
    };

    const pending = (Repository.prototype as any).run.call(
      mockThis,
      Operation.Update,
      async () => {
        operationRan = true;
        return "ok";
      },
      { externalImpact: { traverseExternals: true, targets } }
    );

    await firstBatchStarted;
    await new Promise(resolve => setTimeout(resolve, 20));
    const retriesBeforeRelease = topologyRetries;
    releaseSlow();
    await pending;

    assert.strictEqual(
      retriesBeforeRelease,
      0,
      "retry must wait for every sibling probe to settle"
    );
    assert.ok(
      maxActive <= 16,
      `active scoped reads exceeded cap: ${maxActive}`
    );
  });

  test("Repository.run skips post-operation topology after disposal", async () => {
    const { Repository } = await import("../../../repository");
    let topologyReads = 0;
    const baseRepository: any = {
      isDisposed: false,
      clearBlameCache: () => {},
      getStatus: async () => {
        topologyReads++;
        return [];
      }
    };
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot: process.cwd(),
      externalWorkingCopyRoots: [],
      repository: baseRepository,
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
      async () => {
        baseRepository.isDisposed = true;
        return "ok";
      },
      { externalImpact: { traverseExternals: true } }
    );

    assert.strictEqual(topologyReads, 1);
  });

  test("updateModelState stops when status fails during disposal", async () => {
    const { Repository } = await import("../../../repository");
    let statusReads = 0;
    const baseRepository: any = {
      isDisposed: false
    };
    const mockThis: any = {
      repository: baseRepository,
      sparseDownloadInProgress: false,
      lastModelUpdate: 0,
      MODEL_CACHE_MS: 0,
      statusService: {
        updateStatus: async () => {
          statusReads++;
          baseRepository.isDisposed = true;
          throw Object.assign(new Error("working copy locked"), {
            svnErrorCode: "E155004"
          });
        }
      },
      retryRun: async (fn: () => Promise<unknown>) => fn()
    };

    await assert.doesNotReject(() =>
      (Repository.prototype as any).updateModelState.call(
        mockThis,
        false,
        false,
        false
      )
    );
    assert.strictEqual(statusReads, 1);
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

  test("cleanup variants report external traversal scope", async () => {
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
        cleanupWithExternals: async () => "ok",
        cleanupAdvanced: async () => "ok"
      }
    };

    await (Repository.prototype as any).cleanupWithExternals.call(mockThis);
    await (Repository.prototype as any).cleanupAdvanced.call(mockThis, {
      includeExternals: true
    });
    await (Repository.prototype as any).cleanupAdvanced.call(mockThis, {
      removeIgnored: true
    });

    assert.deepStrictEqual(impacts, [
      { traverseExternals: true },
      { traverseExternals: true },
      { traverseExternals: false }
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
