import * as assert from "assert";
import { makeFakeSvnRepo, BLAME_XML } from "./helpers/fakeSvnRepository";

suite("svnRepository.blameCached / getInfoCached (lock-free peeks)", () => {
  test("blameCached returns warm data without spawning svn", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();
    // Resolve BASE to a number so the entry keys as file@123 (immutable).
    repo.getInfo = async () => ({ revision: "123" });

    await repo.blame("file.txt"); // populates the cache (info + blame)
    const execsAfterFetch = getCount();

    const peek = repo.blameCached("file.txt");
    assert.ok(peek, "warm blame is served from cache");
    assert.strictEqual(
      getCount(),
      execsAfterFetch,
      "blameCached must not spawn a subprocess"
    );
  });

  test("blameCached returns undefined on a cold file (no svn)", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();
    const before = getCount();
    assert.strictEqual(repo.blameCached("never-blamed.txt"), undefined);
    assert.strictEqual(getCount(), before, "cold peek spawns nothing");
  });

  test("blameCached misses unresolved literal BASE entries", async () => {
    const { repo } = await makeFakeSvnRepo();

    // The fake's initial info probe fails, so blame caches under literal BASE.
    await repo.blame("file.txt");
    assert.ok(repo._blameCache.get("file.txt@BASE"));
    assert.strictEqual(repo._baseKeyCache.has("file.txt"), false);

    assert.strictEqual(
      repo.blameCached("file.txt"),
      undefined,
      "full blame must retry info and resolve the current numeric BASE"
    );
  });

  test("getInfoCached returns warm info without spawning svn", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();
    // getInfo default throws in the fake; wire a real-ish info exec via cache.
    repo.exec = async () => ({
      stdout: `<?xml version="1.0"?><info><entry revision="9"><url>u</url><relative-url>^/f</relative-url><repository><root>r</root><uuid>x</uuid></repository><wc-info><wcroot-abspath>/w</wcroot-abspath></wc-info></entry></info>`
    });
    // Restore getInfo to the real prototype method (fake overrode it).
    delete (repo as Record<string, unknown>).getInfo;

    await repo.getInfo("f.txt");
    const before = getCount();
    const peek = repo.getInfoCached("f.txt");
    assert.ok(peek, "warm info is served from cache");
    assert.strictEqual(getCount(), before, "getInfoCached spawns nothing");
    assert.strictEqual(
      repo.getInfoCached("cold.txt"),
      undefined,
      "cold info peek is a miss"
    );
  });

  // Sanity: the fake still parses blame XML (guards the helper).
  test("fake exec returns parseable blame", async () => {
    const { repo } = await makeFakeSvnRepo();
    repo.getInfo = async () => ({ revision: "123" });
    const rows = await repo.blame("x.txt");
    assert.ok(Array.isArray(rows));
    assert.ok(BLAME_XML.includes("blame"));
  });
});
