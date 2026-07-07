import * as assert from "assert";
import { LRUCache } from "../../../util/lruCache";

const BLAME_XML = `<?xml version="1.0"?>
<blame>
  <target path="file.txt">
    <entry line-number="1">
      <commit revision="123">
        <author>john</author>
        <date>2025-11-18T10:00:00.000000Z</date>
      </commit>
    </entry>
  </target>
</blame>`;

function makeRepo() {
  let execCount = 0;
  let execImpl: () => Promise<{ stdout: string }> = async () => ({
    stdout: BLAME_XML
  });
  const repo: any = Object.create(null);
  repo.removeAbsolutePath = (p: string) => p;
  repo.exec = async (_args: string[]) => {
    execCount++;
    return execImpl();
  };
  repo._blameCache = new LRUCache(100, 5 * 60 * 1000);
  repo._blameInFlight = new Map();
  repo._blameErrorCache = new LRUCache(50, 30 * 1000);
  return {
    repo,
    getCount: () => execCount,
    setExec: (impl: typeof execImpl) => (execImpl = impl)
  };
}

async function getSvnRepoProto() {
  const { Repository: SvnRepository } = await import("../../../svnRepository");
  return SvnRepository.prototype;
}

suite("svnRepository.blame caching", () => {
  test("cache hit resolves while an unrelated blame is in flight", async () => {
    const proto = await getSvnRepoProto();
    const { repo, setExec } = makeRepo();
    Object.setPrototypeOf(repo, proto);

    // Warm the cache for fileB
    await proto.blame.call(repo, "fileB.txt");

    // fileA blame hangs (slow network)
    let releaseA!: () => void;
    setExec(
      () =>
        new Promise(resolve => {
          releaseA = () => resolve({ stdout: BLAME_XML });
        })
    );
    const pendingA = proto.blame.call(repo, "fileA.txt");

    // Cached fileB must resolve without waiting for fileA
    const result = await Promise.race([
      proto.blame.call(repo, "fileB.txt").then(() => "resolved"),
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
    const proto = await getSvnRepoProto();
    const { repo, getCount } = makeRepo();
    Object.setPrototypeOf(repo, proto);

    const [a, b] = await Promise.all([
      proto.blame.call(repo, "file.txt"),
      proto.blame.call(repo, "file.txt")
    ]);

    assert.strictEqual(getCount(), 1);
    assert.deepStrictEqual(a, b);
  });

  test("non-transient failure is negative-cached (no re-spawn per event)", async () => {
    const proto = await getSvnRepoProto();
    const { repo, getCount, setExec } = makeRepo();
    Object.setPrototypeOf(repo, proto);

    setExec(() =>
      Promise.reject({
        stderr: "svn: E195012: Cannot calculate blame information for binary"
      })
    );

    await assert.rejects(proto.blame.call(repo, "binary.bin"));
    await assert.rejects(proto.blame.call(repo, "binary.bin"));

    assert.strictEqual(
      getCount(),
      1,
      "second failing blame within TTL must be served from negative cache"
    );
  });

  test("transient failures are not negative-cached", async () => {
    const proto = await getSvnRepoProto();
    const { repo, getCount, setExec } = makeRepo();
    Object.setPrototypeOf(repo, proto);

    setExec(() =>
      Promise.reject({
        stderr: "svn: E170001: Authentication failed"
      })
    );

    await assert.rejects(proto.blame.call(repo, "file.txt"));
    await assert.rejects(proto.blame.call(repo, "file.txt"));

    assert.strictEqual(getCount(), 2, "auth errors must be retryable");
  });
});
