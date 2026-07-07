import * as assert from "assert";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

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
    revision = "130"; // svn update happened
    await repo.blame("file.txt");

    assert.strictEqual(
      getCount(),
      2,
      "changed BASE must produce a fresh fetch, not a stale cache hit"
    );
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
