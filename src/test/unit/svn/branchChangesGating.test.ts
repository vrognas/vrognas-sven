import * as assert from "assert";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

const EMPTY_LOG = `<?xml version="1.0"?>\n<log>\n</log>`;

suite("Branch-changes server-query gating", () => {
  test("copy-point (not-a-copy) is resolved once per branch URL", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();
    (repo as any)._info = {
      url: "https://svn.example.com/repo/branches/x",
      revision: "100",
      repository: { root: "https://svn.example.com/repo" }
    };
    (repo as any)._copyPointCache = new Map();
    setExec(async () => ({ stdout: EMPTY_LOG }));

    const first = await repo.getChanges();
    const second = await repo.getChanges();

    assert.deepStrictEqual(first, []);
    assert.deepStrictEqual(second, []);
    assert.strictEqual(
      getCount(),
      1,
      "a branch's copy origin is immutable - resolve once per session"
    );
  });

  test("copy-point resolution errors are not cached", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();
    (repo as any)._info = {
      url: "https://svn.example.com/repo/branches/x",
      revision: "100",
      repository: { root: "https://svn.example.com/repo" }
    };
    (repo as any)._copyPointCache = new Map();

    setExec(() => Promise.reject(new Error("E170013: unreachable")));
    await assert.rejects(repo.getChanges());

    setExec(async () => ({ stdout: EMPTY_LOG }));
    await repo.getChanges();

    assert.strictEqual(
      getCount(),
      2,
      "an offline failure must not poison the copy-point cache"
    );
  });

  test("copy-point cache cleared by switchBranch", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();
    (repo as any)._info = {
      url: "https://svn.example.com/repo/branches/x",
      revision: "100",
      repository: { root: "https://svn.example.com/repo" }
    };
    (repo as any)._copyPointCache = new Map();
    setExec(async () => ({ stdout: EMPTY_LOG }));

    await repo.getChanges(); // resolves + caches copy point
    await repo.switchBranch("branches/y"); // exec: switch
    await repo.getChanges(); // must re-resolve

    assert.strictEqual(
      getCount(),
      3,
      "switch must clear the copy-point cache (log, switch, log)"
    );
  });

  test("mutating op mid-fetch blocks the changes-cache write-back", async () => {
    const { Repository } = await import("../../../repository");

    let pipelineRuns = 0;
    const mockThis: any = {
      getRepoYoungestRevision: async () => 50,
      _changesGeneration: 0,
      run: async (_op: unknown, fn: () => Promise<unknown>) => {
        pipelineRuns++;
        // A switch completes while the 4-round-trip fetch is in flight
        mockThis._changesGeneration++;
        mockThis._changesCache = undefined;
        return fn();
      },
      repository: { getChanges: async () => [{ oldPath: "old-branch" }] }
    };
    const getChanges = (Repository.prototype as any).getChanges;

    await getChanges.call(mockThis);
    assert.strictEqual(
      mockThis._changesCache,
      undefined,
      "pre-switch result must not repopulate the cleared cache"
    );

    await getChanges.call(mockThis);
    assert.strictEqual(pipelineRuns, 2, "next call re-runs the pipeline");
  });

  test("Repository.getChanges is gated on the repo youngest revision", async () => {
    const { Repository } = await import("../../../repository");

    let pipelineRuns = 0;
    let youngest = 50;
    const mockThis: any = {
      getRepoYoungestRevision: async () => youngest,
      run: async (_op: unknown, fn: () => Promise<unknown>) => {
        pipelineRuns++;
        return fn();
      },
      repository: { getChanges: async () => [{ oldPath: "x" }] }
    };
    const getChanges = (Repository.prototype as any).getChanges;

    await getChanges.call(mockThis);
    await getChanges.call(mockThis); // same revision - cached
    assert.strictEqual(
      pipelineRuns,
      1,
      "unchanged repo revision must not re-run the 4-call pipeline"
    );

    youngest = 51; // a commit landed on either branch
    await getChanges.call(mockThis);
    assert.strictEqual(pipelineRuns, 2, "new revision must re-run it");
  });
});
