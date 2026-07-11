import * as assert from "assert";
import * as sinon from "sinon";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

function makeProvider(sandbox: sinon.SinonSandbox): any {
  const mockRepository = sandbox.createStubInstance(Repository);
  (mockRepository as any).repository = {
    workspaceRoot: "/test",
    root: "/test"
  };
  return new BlameProvider(mockRepository as any);
}

suite("getRevisionRange", () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => (sandbox = sinon.createSandbox()));
  teardown(() => sandbox.restore());

  test("computes min/max and unique revisions sorted newest-first", () => {
    const provider = makeProvider(sandbox);
    const blame: ISvnBlameLine[] = [
      { lineNumber: 1, revision: "100" },
      { lineNumber: 2, revision: "50" },
      { lineNumber: 3, revision: "100" },
      { lineNumber: 4, revision: "200" }
    ];
    const range = (provider as any).getRevisionRange(blame);
    assert.strictEqual(range.min, 50);
    assert.strictEqual(range.max, 200);
    assert.deepStrictEqual(range.uniqueRevisions, [200, 100, 50]);
  });

  test("empty / unrevisioned blame yields zero range", () => {
    const provider = makeProvider(sandbox);
    const range = (provider as any).getRevisionRange([
      { lineNumber: 1 } as ISvnBlameLine
    ]);
    assert.deepStrictEqual(range, { min: 0, max: 0, uniqueRevisions: [] });
  });

  test("does not overflow the stack on a huge file", () => {
    const provider = makeProvider(sandbox);
    // 130k distinct revisions — a Math.min(...arr) spread over this throws
    // RangeError: Maximum call stack size exceeded (V8 limit ~125k args).
    const blame: ISvnBlameLine[] = Array.from({ length: 130_000 }, (_, i) => ({
      lineNumber: i + 1,
      revision: String(i + 1)
    }));
    let range: { min: number; max: number };
    assert.doesNotThrow(() => {
      range = (provider as any).getRevisionRange(blame);
    });
    assert.strictEqual(range!.min, 1);
    assert.strictEqual(range!.max, 130_000);
  });
});
