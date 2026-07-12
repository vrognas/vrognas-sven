import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

const edFor = (uri: Uri) => ({ document: { uri, version: 1 } }) as any;

suite("BlameProvider - LRU Cache Eviction", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
  });

  teardown(() => {
    if (provider) {
      provider.dispose();
    }
    sandbox.restore();
  });

  test("evicts oldest blame cache entry when exceeding MAX_CACHE_SIZE", async () => {
    // Arrange
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "100",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      }
    ];
    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));

    // Create 21 URIs (exceeds MAX_CACHE_SIZE of 20)
    const uris = Array.from({ length: 21 }, (_, i) =>
      Uri.file(`/test/file${i}.txt`)
    );

    // Act - Fill cache with 21 files
    for (const uri of uris) {
      await (provider as any).getBlameData(uri, edFor(uri));
    }

    // Assert - First file should be evicted, last file should exist
    const firstCached = (provider as any).blameCache.has(uris[0]!.toString());
    const lastCached = (provider as any).blameCache.has(uris[20]!.toString());

    assert.strictEqual(firstCached, false, "First file should be evicted");
    assert.strictEqual(lastCached, true, "Last file should remain cached");
    assert.strictEqual(
      (provider as any).blameCache.size,
      20,
      "Cache should have exactly 20 entries"
    );
  });

  test("updates access order when fetching cached blame data", async () => {
    // Arrange
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "100",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      }
    ];
    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));

    const uris = Array.from({ length: 20 }, (_, i) =>
      Uri.file(`/test/file${i}.txt`)
    );

    // Act - Fill cache completely
    for (const uri of uris) {
      await (provider as any).getBlameData(uri, edFor(uri));
    }

    // Access first file again (should move to front of LRU)
    await (provider as any).getBlameData(uris[0], edFor(uris[0]!));

    // Add one more file (should evict second file, not first)
    const newUri = Uri.file("/test/file_new.txt");
    await (provider as any).getBlameData(newUri, edFor(newUri));

    // Assert
    const firstCached = (provider as any).blameCache.has(uris[0]!.toString());
    const secondCached = (provider as any).blameCache.has(uris[1]!.toString());
    const newCached = (provider as any).blameCache.has(newUri.toString());

    assert.strictEqual(
      firstCached,
      true,
      "Recently accessed first file should remain"
    );
    assert.strictEqual(secondCached, false, "Second file should be evicted");
    assert.strictEqual(newCached, true, "New file should be cached");
  });

  test("evicts oldest message cache entries when exceeding MAX_MESSAGE_CACHE_SIZE", async () => {
    // Arrange
    provider = new BlameProvider(scmFor(mockRepository as any));

    // Manually populate messageCache with 501 entries (exceeds MAX_MESSAGE_CACHE_SIZE of 500)
    for (let i = 0; i < 501; i++) {
      (provider as any).messageCache.set(`r${i}`, `Commit message ${i}`);

      // Trigger eviction after adding entry
      (provider as any).evictMessageCache();
    }

    // Assert
    const firstCached = (provider as any).messageCache.has("r0");
    const lastCached = (provider as any).messageCache.has("r500");

    assert.strictEqual(firstCached, false, "First message should be evicted");
    assert.strictEqual(lastCached, true, "Last message should remain cached");
    assert.ok(
      (provider as any).messageCache.size <= 500,
      "Message cache should not exceed 500 entries"
    );
  });
});
