import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";

function makeProvider(sandbox: sinon.SinonSandbox): any {
  const mockRepository = sandbox.createStubInstance(Repository);
  (mockRepository as any).repository = {
    workspaceRoot: "/test",
    root: "/test"
  };
  return new BlameProvider(scmFor(mockRepository as any));
}

suite("BlameProvider - cache eviction", () => {
  let sandbox: sinon.SinonSandbox;
  let provider: any;

  setup(() => (sandbox = sinon.createSandbox()));
  teardown(() => {
    provider?.dispose();
    sandbox.restore();
  });

  test("revisionColors evicts a fraction instead of clearing all", () => {
    provider = makeProvider(sandbox);
    const colors: Map<string, string> = provider.revisionColors;
    for (let i = 0; i <= 2000; i++) {
      colors.set(`k${i}`, "#000000");
    }

    // A cache miss triggers the size check; a full clear() would drop to ~1.
    provider.getRevisionColor("100", {
      min: 100,
      max: 100,
      uniqueRevisions: [100]
    });

    assert.ok(
      colors.size > 100 && colors.size <= 2000,
      `fractional eviction expected, got size ${colors.size}`
    );
  });

  test("messageCache eviction is LRU (keeps recently-read entries)", () => {
    provider = makeProvider(sandbox);
    const cache: Map<string, string> = provider.messageCache;
    const max: number = provider.MAX_MESSAGE_CACHE_SIZE;
    const key = (r: string) => provider.msgKey("", r); // scope-agnostic here
    for (let i = 0; i < max; i++) {
      cache.set(key(`r${i}`), `m${i}`);
    }

    // Read the oldest entry - LRU must refresh its recency.
    provider.readMessage("", "r0");

    // Push past the cap and evict.
    cache.set(key("rNew"), "mNew");
    provider.evictMessageCache();

    assert.ok(cache.has(key("r0")), "recently-read oldest entry survives");
    assert.ok(!cache.has(key("r1")), "never-read next-oldest is evicted");
  });
});
