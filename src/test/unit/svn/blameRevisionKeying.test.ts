import * as assert from "assert";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

const infoXml = (revision: string) =>
  `<?xml version="1.0"?><info><entry revision="${revision}"><url>https://svn.example.com/repo/file.txt</url><relative-url>^/file.txt</relative-url><repository><root>https://svn.example.com/repo</root><uuid>x</uuid></repository><wc-info><wcroot-abspath>/wc</wcroot-abspath></wc-info></entry></info>`;

suite("Blame cache revision keying", () => {
  test("BASE resolves to the file's revision for the cache key", async () => {
    const { repo } = await makeFakeSvnRepo();
    repo.getInfo = async () => ({ revision: "123" });

    await repo.blame("file.txt");

    assert.ok(
      repo._blameCache.get("file.txt@123") !== undefined,
      "cache key must carry the resolved numeric BASE revision"
    );
    assert.strictEqual(repo._blameCache.get("file.txt@BASE"), undefined);
  });

  test("a new BASE revision misses the old key (no stale blame)", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();
    let revision = "123";
    repo.getInfo = async () => ({ revision });

    await repo.blame("file.txt");
    // svn update happened externally: updateInfo detects the revision
    // change and runs clearBlameCache (which also drops the session-
    // sticky BASE-key memo) - simulate that invalidation event here
    revision = "130";
    repo.clearBlameCache();
    await repo.blame("file.txt");

    assert.strictEqual(
      getCount(),
      2,
      "changed BASE must produce a fresh fetch, not a stale cache hit"
    );
  });

  test("invalidation during BASE info resolution retries the new revision", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo } = await makeFakeSvnRepo();
    repo.getInfo = (...args: unknown[]) =>
      (SvnRepository.prototype.getInfo as any).call(repo, ...args);

    let infoCount = 0;
    let releaseFirstInfo!: () => void;
    let markInfoStarted!: () => void;
    const infoStarted = new Promise<void>(
      resolve => (markInfoStarted = resolve)
    );
    const blameRevisions: string[] = [];
    repo.exec = async (args: string[]) => {
      if (args[0] === "info") {
        infoCount++;
        if (infoCount === 1) {
          markInfoStarted();
          return new Promise(resolve => {
            releaseFirstInfo = () => resolve({ stdout: infoXml("10") });
          });
        }
        return { stdout: infoXml("11") };
      }

      const revisionIndex = args.indexOf("-r");
      blameRevisions.push(args[revisionIndex + 1]!);
      const { BLAME_XML } = await import("./helpers/fakeSvnRepository");
      return { stdout: BLAME_XML };
    };

    const pending = repo.blame("file.txt");
    await infoStarted;
    repo.clearBlameCache();
    releaseFirstInfo();
    await pending;

    assert.strictEqual(infoCount, 2, "BASE must be resolved again after clear");
    assert.deepStrictEqual(blameRevisions, ["11"]);
    assert.strictEqual(repo._baseKeyCache.get("file.txt"), "11");
    assert.strictEqual(repo._blameCache.get("file.txt@10"), undefined);
    assert.ok(repo._blameCache.get("file.txt@11"));
  });

  test("direct info retries when invalidated in flight", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo } = await makeFakeSvnRepo();
    let infoCount = 0;
    let releaseFirstInfo!: () => void;
    let markInfoStarted!: () => void;
    const infoStarted = new Promise<void>(
      resolve => (markInfoStarted = resolve)
    );
    repo.exec = async () => {
      infoCount++;
      if (infoCount === 1) {
        markInfoStarted();
        return new Promise(resolve => {
          releaseFirstInfo = () => resolve({ stdout: infoXml("10") });
        });
      }
      return { stdout: infoXml("11") };
    };

    const pending = SvnRepository.prototype.getInfo.call(repo, "file.txt");
    await infoStarted;
    repo.clearBlameCache();
    releaseFirstInfo();
    const info = await pending;

    assert.strictEqual(infoCount, 2);
    assert.strictEqual(info.revision, "11");
    assert.strictEqual(repo._infoCache.get("file.txt")?.revision, "11");
  });

  test("root info refresh retries a result invalidated in flight", async () => {
    const { repo } = await makeFakeSvnRepo();
    repo.workspaceRoot = "/wc";
    repo.root = "/wc";
    repo.lastInfoUpdate = 0;
    repo._info = { revision: "9", url: "https://svn.example.com/repo/old" };
    let releaseInfo!: () => void;
    let markInfoStarted!: () => void;
    const infoStarted = new Promise<void>(
      resolve => (markInfoStarted = resolve)
    );
    let infoCount = 0;
    repo.exec = async () => {
      infoCount++;
      if (infoCount === 1) {
        markInfoStarted();
        return new Promise(resolve => {
          releaseInfo = () => resolve({ stdout: infoXml("10") });
        });
      }
      return { stdout: infoXml("11") };
    };

    const pending = repo.updateInfo(true);
    await infoStarted;
    repo.clearBlameCache();
    releaseInfo();
    await pending;

    assert.strictEqual(infoCount, 2);
    assert.strictEqual(repo._info.revision, "11");
    assert.strictEqual(repo._infoCache.get("")?.revision, "11");
    assert.ok(repo.lastInfoUpdate > 0);
  });

  test("direct info aborts instead of retrying after disposal", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo } = await makeFakeSvnRepo();
    let infoCount = 0;
    let releaseInfo!: () => void;
    let markInfoStarted!: () => void;
    const infoStarted = new Promise<void>(
      resolve => (markInfoStarted = resolve)
    );
    repo.exec = async () => {
      infoCount++;
      if (infoCount === 1) {
        markInfoStarted();
        return new Promise(resolve => {
          releaseInfo = () => resolve({ stdout: infoXml("10") });
        });
      }
      return { stdout: infoXml("11") };
    };

    const pending = SvnRepository.prototype.getInfo.call(repo, "file.txt");
    await infoStarted;
    repo.clearInfoCacheTimers();
    releaseInfo();

    await assert.rejects(pending, /disposed/i);
    assert.strictEqual(infoCount, 1);
    assert.strictEqual(repo._infoCache.get("file.txt"), undefined);
  });

  test("root info refresh rejects when disposed in flight", async () => {
    const { repo } = await makeFakeSvnRepo();
    repo.workspaceRoot = "/wc";
    repo.root = "/wc";
    repo.lastInfoUpdate = 0;
    let releaseInfo!: () => void;
    let markInfoStarted!: () => void;
    const infoStarted = new Promise<void>(
      resolve => (markInfoStarted = resolve)
    );
    repo.exec = async () => {
      markInfoStarted();
      return new Promise(resolve => {
        releaseInfo = () => resolve({ stdout: infoXml("10") });
      });
    };

    const pending = repo.updateInfo(true);
    await infoStarted;
    repo.clearInfoCacheTimers();
    releaseInfo();

    await assert.rejects(pending, /disposed/i);
    assert.strictEqual(repo._infoCache.get(""), undefined);
  });

  test("blame cannot start after disposal during BASE resolution", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { BLAME_XML } = await import("./helpers/fakeSvnRepository");
    const { repo } = await makeFakeSvnRepo();
    repo.getInfo = (...args: unknown[]) =>
      (SvnRepository.prototype.getInfo as any).call(repo, ...args);
    let releaseInfo!: () => void;
    let markInfoStarted!: () => void;
    const infoStarted = new Promise<void>(
      resolve => (markInfoStarted = resolve)
    );
    let blameCount = 0;
    repo.exec = async (args: string[]) => {
      if (args[0] === "info") {
        markInfoStarted();
        return new Promise(resolve => {
          releaseInfo = () => resolve({ stdout: infoXml("10") });
        });
      }
      blameCount++;
      return { stdout: BLAME_XML };
    };

    const pending = repo.blame("file.txt");
    await infoStarted;
    repo.clearInfoCacheTimers();
    releaseInfo();

    await assert.rejects(pending, /disposed/i);
    await assert.rejects(repo.blame("file.txt", "10"), /disposed/i);
    assert.strictEqual(blameCount, 0);
    assert.strictEqual(repo._blameCache.size, 0);
  });

  test("invalidated root info cannot namespace persistent blame", async () => {
    const { repo } = await makeFakeSvnRepo();
    repo._info = { url: "https://svn.example.com/repo/branch-a" };

    assert.ok(repo.persistentBlameKey("file.txt@10"));
    repo.clearBlameCache();

    assert.strictEqual(repo.persistentBlameKey("file.txt@10"), undefined);
  });

  test("resolved revision is pegged into the fetch (key/content coherent)", async () => {
    const { repo } = await makeFakeSvnRepo();
    repo.getInfo = async () => ({ revision: "123" });
    let captured: string[] = [];
    repo.exec = async (args: string[]) => {
      captured = args;
      const { BLAME_XML } = await import("./helpers/fakeSvnRepository");
      return { stdout: BLAME_XML };
    };

    await repo.blame("file.txt");

    const rIdx = captured.indexOf("-r");
    assert.strictEqual(
      captured[rIdx + 1],
      "123",
      "fetch must use the resolved revision, not the mutable BASE keyword" +
        " - otherwise stale resolution poisons an immutable key"
    );
  });

  test("clearBlameCache clears per-file info entries (key coherence)", async () => {
    const { repo } = await makeFakeSvnRepo();
    repo._infoCache.set("some/file.txt", { revision: "100" });

    repo.clearBlameCache();

    assert.strictEqual(
      repo._infoCache.get("some/file.txt"),
      undefined,
      "stale per-file info must not resolve blame keys after a mutation"
    );
  });

  test("resolution failure falls back to the literal BASE key", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();
    // fixture default getInfo throws - resolution must degrade gracefully

    await repo.blame("file.txt");
    await repo.blame("file.txt");

    assert.strictEqual(getCount(), 1, "literal-BASE key still caches");
    assert.ok(repo._blameCache.get("file.txt@BASE") !== undefined);
  });
});
