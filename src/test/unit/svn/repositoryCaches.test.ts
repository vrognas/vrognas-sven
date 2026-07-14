import * as assert from "assert";
import { LRUCache } from "../../../util/lruCache";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

/**
 * Diff-open produces two svn-scheme URIs (different rev params) that both
 * resolve to the same fsPath. svnFileSystemProvider's stat cache is keyed
 * by URI string, so both miss and each fires its own remote `svn list
 * <URL>`. svnRepository.list must dedup at the URL layer.
 */
suite("svnRepository.list URL-keyed TTL cache", () => {
  const makeRepo = () => {
    let execCount = 0;
    const repo: any = Object.create(null);
    repo.getRepoUrl = async () => "https://svn.example.com/repo";
    repo.exec = async (_args: string[]) => {
      execCount++;
      return { stdout: "<lists><list><entry/></list></lists>" };
    };
    repo._listCache = new LRUCache(200, 30 * 1000);
    repo._listInFlight = new Map();
    return { repo, getCount: () => execCount };
  };

  test("Two sequential calls for the same folder share one exec", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo, getCount } = makeRepo();
    Object.setPrototypeOf(repo, SvnRepository.prototype);

    await SvnRepository.prototype.list.call(repo, "path/to/file.txt");
    await SvnRepository.prototype.list.call(repo, "path/to/file.txt");

    assert.strictEqual(getCount(), 1);
  });

  test("Different folders bypass cache", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo, getCount } = makeRepo();
    Object.setPrototypeOf(repo, SvnRepository.prototype);

    await SvnRepository.prototype.list.call(repo, "file1.txt");
    await SvnRepository.prototype.list.call(repo, "file2.txt");

    assert.strictEqual(getCount(), 2);
  });
});

/**
 * Diff-open invokes svn cat from two places sequentially:
 *   1. svnFileSystemProvider.readFile → showBuffer(fsPath) (no revision
 *      → SVN defaults to BASE for working-copy paths → args: ["cat", target])
 *   2. BlameProvider.computeLineMapping → show(fsPath, "BASE")
 *      → args: ["cat", "-r", "BASE", target]
 *
 * Both return identical BASE content but had different exec args, so the
 * in-flight dedup didn't unify them. prepareCatArgs now normalizes the
 * default; the short-TTL _catCache covers sequential callers.
 */
suite("svnRepository.cat normalization + cache", () => {
  test("sequential cat with and without -r BASE shares one execBuffer", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );

    let execCount = 0;
    const repo: any = Object.create(SvnRepository.prototype);
    repo.workspaceRoot = "C:/repo";
    repo.removeAbsolutePath = (p: string) =>
      p.startsWith("C:/repo/") ? p.slice("C:/repo/".length) : p;
    repo.relativize = (p: string) =>
      p.startsWith("C:/repo/") ? p.slice("C:/repo/".length) : p;
    repo.buildPegPath = (target: string, _rev?: string) => target;
    repo.getInfo = async () => ({
      url: "https://svn.example.com/repo",
      repository: { uuid: "fake" }
    });
    repo.execBuffer = async (_args: string[]) => {
      execCount++;
      return { exitCode: 0, stdout: Buffer.from("base content"), stderr: "" };
    };
    repo._catInFlight = new Map();
    repo._catCache = new LRUCache(50, 30 * 1000);

    await SvnRepository.prototype.showBuffer.call(repo, "C:/repo/file.txt");
    await SvnRepository.prototype.showBuffer.call(
      repo,
      "C:/repo/file.txt",
      "BASE"
    );

    assert.strictEqual(execCount, 1);
  });

  test("cat propagates execBuffer rejection unchanged", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const failure = new Error("svn cat failed");
    const repo: any = Object.create(SvnRepository.prototype);
    repo.execBuffer = async () => {
      throw failure;
    };
    repo._catInFlight = new Map();
    repo._catCache = new LRUCache(50, 30 * 1000);

    await assert.rejects(
      (SvnRepository.prototype as any).showBufferWithArgs.call(repo, [
        "cat",
        "file.txt"
      ]),
      error => error === failure
    );
  });
});

suite("svnRepository property-change cache lifetime", () => {
  test("clear detaches an older property-diff fetch", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();
    const resolvers: Array<(value: { stdout: string }) => void> = [];
    setExec(
      () =>
        new Promise(resolve => {
          resolvers.push(resolve);
        })
    );

    const oldRead = repo.getPropertyChanges("file.txt");
    repo.clearPropertyChangesCache();
    const freshRead = repo.getPropertyChanges("file.txt");

    assert.strictEqual(getCount(), 2);
    resolvers[1]!({ stdout: "Added: svn:fresh" });
    assert.deepStrictEqual(await freshRead, [
      { name: "svn:fresh", changeType: "added" }
    ]);
    resolvers[0]!({ stdout: "Added: svn:stale" });
    await oldRead;

    assert.deepStrictEqual(await repo.getPropertyChanges("file.txt"), [
      { name: "svn:fresh", changeType: "added" }
    ]);
    assert.strictEqual(getCount(), 2);
  });

  test("dispose prevents a pending property diff from repopulating cache", async () => {
    const { repo, setExec } = await makeFakeSvnRepo();
    let resolveRead!: (value: { stdout: string }) => void;
    setExec(
      () =>
        new Promise(resolve => {
          resolveRead = resolve;
        })
    );

    const read = repo.getPropertyChanges("file.txt");
    repo.clearInfoCacheTimers();
    resolveRead({ stdout: "Added: svn:stale" });
    await read;

    assert.strictEqual(repo._propertyChangesInFlight.size, 0);
    assert.strictEqual(repo._propertyChangesCache.get("file.txt"), undefined);
  });
});
