import * as assert from "assert";
import { LRUCache } from "../../../util/lruCache";
import { Operation, RepositoryState } from "../../../common/types";

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

function makeSvnRepo() {
  let execCount = 0;
  const repo: any = Object.create(null);
  repo.removeAbsolutePath = (p: string) => p;
  repo.getRepoUrl = async () => "https://svn.example.com/repo";
  repo.exec = async (_args: string[]) => {
    execCount++;
    return { stdout: BLAME_XML };
  };
  repo._infoCache = new LRUCache(500, 2 * 60 * 1000);
  repo._blameCache = new LRUCache(100, 5 * 60 * 1000);
  repo._blameInFlight = new Map();
  repo._blameErrorCache = new LRUCache(50, 30 * 1000);
  return { repo, getCount: () => execCount };
}

suite("Blame cache invalidation on mutating operations", () => {
  test("clearBlameCache drops blame results and cached errors", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo, getCount } = makeSvnRepo();
    Object.setPrototypeOf(repo, SvnRepository.prototype);

    await SvnRepository.prototype.blame.call(repo, "file.txt");
    repo._blameErrorCache.set("bad.bin@BASE", "Cannot blame binary file");

    (SvnRepository.prototype as any).clearBlameCache.call(repo);

    assert.strictEqual(repo._blameCache.get("file.txt@BASE"), undefined);
    assert.strictEqual(repo._blameErrorCache.get("bad.bin@BASE"), undefined);

    await SvnRepository.prototype.blame.call(repo, "file.txt");
    assert.strictEqual(getCount(), 2, "post-clear blame must re-fetch");
  });

  test("switchBranch clears the blame cache", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo } = makeSvnRepo();
    Object.setPrototypeOf(repo, SvnRepository.prototype);

    await SvnRepository.prototype.blame.call(repo, "file.txt");
    assert.ok(repo._blameCache.get("file.txt@BASE") !== undefined);

    await SvnRepository.prototype.switchBranch.call(repo, "branches/x");

    assert.strictEqual(
      repo._blameCache.get("file.txt@BASE"),
      undefined,
      "switch changes BASE content - blame cache must be dropped"
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
});
