import * as assert from "assert";
import { Repository } from "../../../repository";
import { Operation } from "../../../common/types";
import { ISvnBlameLine } from "../../../common/types";

/**
 * Repository.blame/getInfo must serve warm cache hits WITHOUT entering run()
 * (which holds the per-repo credentialLock and would queue the hit behind a
 * slow in-flight network op).
 */
suite("Repository blame/info lock bypass", () => {
  const DATA: ISvnBlameLine[] = [
    { lineNumber: 1, revision: "1", author: "a", date: "d" }
  ];

  function fakeRepo(overrides: Record<string, unknown>) {
    let runCalls = 0;
    const self: Record<string, unknown> = {
      run: (_op: Operation, fn: () => Promise<unknown>) => {
        runCalls++;
        return fn();
      },
      repository: overrides,
      runCallCount: () => runCalls
    };
    return self;
  }

  test("blame() returns a warm cache hit without run()", async () => {
    const self = fakeRepo({
      blameCached: () => DATA,
      blame: () => Promise.reject(new Error("must not fetch on a hit"))
    });
    const result = await Repository.prototype.blame.call(self as never, "/f");
    assert.deepStrictEqual(result, DATA);
    assert.strictEqual((self.runCallCount as () => number)(), 0);
  });

  test("blame() falls back to run() on a cache miss", async () => {
    const self = fakeRepo({
      blameCached: () => undefined,
      blame: () => Promise.resolve(DATA)
    });
    const result = await Repository.prototype.blame.call(self as never, "/f");
    assert.deepStrictEqual(result, DATA);
    assert.strictEqual((self.runCallCount as () => number)(), 1);
  });

  test("getInfo() returns a warm cache hit without run()", async () => {
    const INFO = { revision: "9" };
    const self = fakeRepo({
      getInfoCached: () => INFO,
      getInfo: () => Promise.reject(new Error("must not fetch on a hit"))
    });
    const result = await Repository.prototype.getInfo.call(self as never, "/f");
    assert.deepStrictEqual(result, INFO);
    assert.strictEqual((self.runCallCount as () => number)(), 0);
  });
});
