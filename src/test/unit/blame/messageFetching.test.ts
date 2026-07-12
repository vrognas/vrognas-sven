import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { Repository } from "../../../repository";

const TARGET = Uri.file("/test/file.ts");

suite("BlameProvider - Message Fetching", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    // workspaceRoot (getter delegates to inner repo) scopes the message cache.
    (mockRepository as any).repository = { workspaceRoot: "/test" };
    provider = new BlameProvider(scmFor(mockRepository as any));
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("fetches message from repository on cache miss", async () => {
    // Given: Repository returns log entry
    const revision = "1234";
    const expectedMsg = "Fix critical bug in parser";
    mockRepository.log.resolves([
      {
        revision,
        msg: expectedMsg,
        author: "john",
        date: "2025-11-18"
      }
    ] as any);

    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    // When: Get message (cache miss)
    const message = await (provider as any).getCommitMessage(revision);

    // Then: Returns message from repo
    assert.strictEqual(message, expectedMsg);
    assert.ok(mockRepository.log.calledOnce);
    assert.ok(mockRepository.log.calledWith(revision, revision, 1));
  });

  test("returns cached message without repository call", async () => {
    // Given: First call populates cache
    const revision = "1234";
    mockRepository.log.resolves([{ msg: "Cached message", revision }] as any);

    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    await (provider as any).getCommitMessage(revision);
    mockRepository.log.resetHistory();

    // When: Second call (cache hit)
    const message = await (provider as any).getCommitMessage(revision);

    // Then: Returns cached message, no repo call
    assert.strictEqual(message, "Cached message");
    assert.ok(mockRepository.log.notCalled);
  });

  test("returns empty string when logs disabled", async () => {
    // Given: Logs disabled in config
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(false);

    // When: Get message
    const message = await (provider as any).getCommitMessage("1234");

    // Then: Empty string, no repo call
    assert.strictEqual(message, "");
    assert.ok(mockRepository.log.notCalled);
  });

  test("handles fetch errors gracefully", async () => {
    // Given: Repository throws error
    mockRepository.log.rejects(new Error("Network timeout"));

    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    // When: Get message
    const message = await (provider as any).getCommitMessage("1234");

    // Then: Returns empty string (no crash)
    assert.strictEqual(message, "");
  });

  test("prefetches multiple messages efficiently", async () => {
    // Given: 5 unique revisions
    const revisions = ["1000", "1001", "1002", "1003", "1004"];
    mockRepository.log.resolves([{ msg: "Test", revision: "1000" }] as any);

    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    // When: Prefetch batch
    await (provider as any).prefetchMessages(revisions, TARGET);

    // Then: All fetched and cached
    assert.strictEqual((provider as any).messageCache.size, 5);
    assert.strictEqual(mockRepository.log.callCount, 5);
  });

  test("prefetch skips already cached revisions", async () => {
    // Given: 2 revisions already cached (under the target's repo scope)
    const key = (r: string) => (provider as any).msgKey("/test", r);
    (provider as any).messageCache.set(key("1000"), "Cached 1");
    (provider as any).messageCache.set(key("1001"), "Cached 2");

    mockRepository.log.resolves([{ msg: "New", revision: "1002" }] as any);

    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    // When: Prefetch 3 revisions (2 cached, 1 new)
    const revisions = ["1000", "1001", "1002"];
    await (provider as any).prefetchMessages(revisions, TARGET);

    // Then: Only 1 fetch call (for uncached)
    assert.strictEqual(mockRepository.log.callCount, 1);
    assert.strictEqual((provider as any).messageCache.size, 3);
  });

  test("prefetch eviction preserves current-file cache hits", async () => {
    const p = provider as any;
    const key = (r: string) => p.msgKey("/test", r);
    const hits = Array.from({ length: 80 }, (_, i) => `hit-${i}`);
    const misses = Array.from({ length: 20 }, (_, i) => `miss-${i}`);
    for (const revision of hits) {
      p.messageCache.set(key(revision), `message ${revision}`);
    }
    for (let i = 0; i < 410; i++) {
      p.messageCache.set(key(`other-${i}`), `other ${i}`);
    }
    mockRepository.logBatch.resolves(
      misses.map(revision => ({ revision, msg: `message ${revision}` })) as any
    );
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    await p.prefetchMessages([...hits, ...misses], TARGET);

    assert.ok(
      hits.every(revision => p.messageCache.has(key(revision))),
      "messages needed by this apply must survive eviction"
    );
  });
});
