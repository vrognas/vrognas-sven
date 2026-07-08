import * as assert from "assert";
import { pLimit } from "../../../util/pLimit";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

suite("pLimit", () => {
  test("preserves input order in results regardless of completion order", async () => {
    // Later tasks resolve first, but results must stay index-aligned
    const tasks = [
      () => delay(30).then(() => "a"),
      () => delay(5).then(() => "b"),
      () => delay(15).then(() => "c")
    ];

    const results = await pLimit(tasks, 3);

    assert.deepStrictEqual(results, ["a", "b", "c"]);
  });

  test("never runs more than `concurrency` tasks at once", async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
    });

    await pLimit(tasks, 3);

    assert.ok(maxActive <= 3, `expected max 3 concurrent, saw ${maxActive}`);
    assert.strictEqual(active, 0, "all tasks should have finished");
  });

  test("returns an empty array for no tasks", async () => {
    const results = await pLimit<number>([], 5);
    assert.deepStrictEqual(results, []);
  });
});
