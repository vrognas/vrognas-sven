import * as assert from "assert";
import { Repository } from "../../../repository";
import { Operation, RepositoryState } from "../../../common/types";
import { ISvnBlameLine } from "../../../common/types";

/**
 * Repository.blame/getInfo must serve warm cache hits WITHOUT entering run()
 * (which holds the per-repo credentialLock and would queue the hit behind a
 * slow in-flight network op) - but ONLY when the repo is Idle and no mutating
 * operation is in flight (which is about to change BASE and clear the caches).
 */
suite("Repository blame/info lock bypass", () => {
  const DATA: ISvnBlameLine[] = [
    { lineNumber: 1, revision: "1", author: "a", date: "d" }
  ];

  function fakeRepo(
    repository: Record<string, unknown>,
    opts: { state?: RepositoryState; running?: Operation[] } = {}
  ) {
    let runCalls = 0;
    const running = new Set(opts.running ?? []);
    const self: Record<string, unknown> = {
      run: (_op: Operation, fn: () => Promise<unknown>) => {
        runCalls++;
        return fn();
      },
      state: opts.state ?? RepositoryState.Idle,
      operations: { isRunning: (op: Operation) => running.has(op) },
      // Exercise the REAL guard logic against this fake's state/operations.
      canServeCachedRead: (
        Repository.prototype as unknown as { canServeCachedRead: () => boolean }
      ).canServeCachedRead,
      repository,
      runCallCount: () => runCalls
    };
    return self;
  }

  const runs = (self: Record<string, unknown>) =>
    (self.runCallCount as () => number)();

  test("blame() returns a warm cache hit without run()", async () => {
    const self = fakeRepo({
      blameCached: () => DATA,
      blame: () => Promise.reject(new Error("must not fetch on a hit"))
    });
    const result = await Repository.prototype.blame.call(self as never, "/f");
    assert.deepStrictEqual(result, DATA);
    assert.strictEqual(runs(self), 0);
  });

  test("blame() falls back to run() on a cache miss", async () => {
    const self = fakeRepo({
      blameCached: () => undefined,
      blame: () => Promise.resolve(DATA)
    });
    const result = await Repository.prototype.blame.call(self as never, "/f");
    assert.deepStrictEqual(result, DATA);
    assert.strictEqual(runs(self), 1);
  });

  test("blame() does NOT bypass when the repo is not Idle", async () => {
    const self = fakeRepo(
      {
        blameCached: () => DATA,
        blame: () => Promise.resolve(DATA)
      },
      { state: RepositoryState.Disposed }
    );
    await Repository.prototype.blame.call(self as never, "/f");
    assert.strictEqual(runs(self), 1, "not-Idle must go through run()");
  });

  test("blame() does NOT bypass while a mutating op is in flight", async () => {
    const self = fakeRepo(
      {
        blameCached: () => DATA,
        blame: () => Promise.resolve(DATA)
      },
      { running: [Operation.Update] }
    );
    await Repository.prototype.blame.call(self as never, "/f");
    assert.strictEqual(
      runs(self),
      1,
      "mutating op in flight must go through run()"
    );
  });

  test("getInfo() returns a warm cache hit without run()", async () => {
    const INFO = { revision: "9" };
    const self = fakeRepo({
      getInfoCached: () => INFO,
      getInfo: () => Promise.reject(new Error("must not fetch on a hit"))
    });
    const result = await Repository.prototype.getInfo.call(self as never, "/f");
    assert.deepStrictEqual(result, INFO);
    assert.strictEqual(runs(self), 0);
  });

  test("getInfo() does NOT bypass while a mutating op is in flight", async () => {
    const INFO = { revision: "9" };
    const self = fakeRepo(
      { getInfoCached: () => INFO, getInfo: () => Promise.resolve(INFO) },
      { running: [Operation.Commit] }
    );
    await Repository.prototype.getInfo.call(self as never, "/f");
    assert.strictEqual(runs(self), 1);
  });
});
