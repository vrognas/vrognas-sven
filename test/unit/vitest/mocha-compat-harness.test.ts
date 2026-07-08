import * as assert from "assert";

suite("Mocha Compat Harness", () => {
  test("supports done callback", function (done: (err?: unknown) => void) {
    done();
  });

  test("supports timeout context api", function () {
    this.timeout(1);
    assert.ok(true);
  });

  test("supports skip context api", function () {
    // skip() is typed `never`; call via a void-typed wrapper so the
    // reached-flag assignment below stays statically reachable
    const invokeSkip: () => void = () => this.skip();
    let reachedAfterSkip = false;
    try {
      invokeSkip();
      reachedAfterSkip = true;
    } finally {
      assert.strictEqual(reachedAfterSkip, false);
    }
  });

  test("supports async skip context api", async function () {
    await Promise.resolve();
    this.skip();
  });
});
