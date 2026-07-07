import * as assert from "assert";
import { Uri } from "vscode";
import { LRUCache } from "../../../util/lruCache";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

function wireBufferExec(repo: any) {
  let count = 0;
  repo._catInFlight = new Map();
  repo._catCache = new LRUCache(50, 20); // 20ms base TTL to observe expiry
  repo.execBuffer = async (_args: string[]) => {
    count++;
    return { exitCode: 0, stdout: Buffer.from("content"), stderr: "" };
  };
  return () => count;
}

suite("Immutable pinned-revision cache tier", () => {
  test("LRUCache per-entry TTL override outlives the base TTL", async () => {
    const cache = new LRUCache<number>(10, 20);
    cache.set("short", 1);
    cache.set("long", 2, 10_000);

    await new Promise(r => setTimeout(r, 60));

    assert.strictEqual(cache.get("short"), undefined, "base TTL expires");
    assert.strictEqual(cache.get("long"), 2, "override TTL survives");
  });

  test("cat at a pinned numeric revision outlives the base cat TTL", async () => {
    const { repo } = await makeFakeSvnRepo();
    const getCount = wireBufferExec(repo);
    const url = Uri.parse("https://svn.example.com/repo/f.txt");

    await repo.showBuffer(url, "123");
    await new Promise(r => setTimeout(r, 60)); // base 20ms TTL lapses
    await repo.showBuffer(url, "123");

    assert.strictEqual(
      getCount(),
      1,
      "content at a numeric revision is immutable - no re-fetch after TTL"
    );
  });

  test("HEAD is NOT pinned - keeps the short TTL", async () => {
    const { repo } = await makeFakeSvnRepo();
    const getCount = wireBufferExec(repo);
    const url = Uri.parse("https://svn.example.com/repo/f.txt");

    await repo.showBuffer(url, "HEAD");
    await new Promise(r => setTimeout(r, 60));
    await repo.showBuffer(url, "HEAD");

    assert.strictEqual(
      getCount(),
      2,
      "HEAD content is mutable - must re-fetch after the short TTL"
    );
  });

  test("patchRevision (svn diff -c REV) is cached for numeric revisions", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();
    setExec(async () => ({ stdout: "Index: f.txt\n..." }));
    const url = Uri.parse("https://svn.example.com/repo/f.txt");

    const a = await repo.patchRevision("123", url);
    const b = await repo.patchRevision("123", url);

    assert.strictEqual(a, b);
    assert.strictEqual(
      getCount(),
      1,
      "diff of a pinned revision is immutable - one fetch per session"
    );
  });
});
