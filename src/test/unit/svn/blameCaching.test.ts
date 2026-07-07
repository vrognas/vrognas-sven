import * as assert from "assert";
import { BLAME_XML, makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

suite("svnRepository.blame caching", () => {
  test("cache hit resolves while an unrelated blame is in flight", async () => {
    const { repo, setExec } = await makeFakeSvnRepo();

    // Warm the cache for fileB
    await repo.blame("fileB.txt");

    // fileA blame hangs (slow network)
    let releaseA!: () => void;
    setExec(
      () =>
        new Promise(resolve => {
          releaseA = () => resolve({ stdout: BLAME_XML });
        })
    );
    const pendingA = repo.blame("fileA.txt");

    // Cached fileB must resolve without waiting for fileA
    const result = await Promise.race([
      repo.blame("fileB.txt").then(() => "resolved"),
      new Promise(r => setTimeout(() => r("timed out"), 300))
    ]);
    assert.strictEqual(
      result,
      "resolved",
      "cache hit must not queue behind in-flight blame"
    );

    releaseA();
    await pendingA;
  });

  test("concurrent blames of the same file share one exec", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();

    const [a, b] = await Promise.all([
      repo.blame("file.txt"),
      repo.blame("file.txt")
    ]);

    assert.strictEqual(getCount(), 1);
    assert.deepStrictEqual(a, b);
  });

  test("non-transient failure is negative-cached (no re-spawn per event)", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();

    setExec(() =>
      Promise.reject({
        stderr: "svn: E195012: Cannot calculate blame information for binary"
      })
    );

    await assert.rejects(repo.blame("binary.bin"));
    await assert.rejects(repo.blame("binary.bin"));

    assert.strictEqual(
      getCount(),
      1,
      "second failing blame within TTL must be served from negative cache"
    );
  });

  test("transient failures are not negative-cached", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();

    setExec(() =>
      Promise.reject({
        stderr: "svn: E170001: Authentication failed"
      })
    );

    await assert.rejects(repo.blame("file.txt"));
    await assert.rejects(repo.blame("file.txt"));

    assert.strictEqual(getCount(), 2, "auth errors must be retryable");
  });
});
