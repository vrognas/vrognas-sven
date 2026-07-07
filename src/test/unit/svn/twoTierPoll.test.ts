import * as assert from "assert";

async function makePollHarness(opts: {
  hasChanges?: boolean;
  remoteUiCount?: number;
  lockSweepFresh?: boolean;
}) {
  const { Repository } = await import("../../../repository");
  let fullFetches = 0;
  let probes = 0;
  const mockThis: any = {
    getConfig: () => ({ remoteChangesCheckFrequency: 300 }),
    probeRemoteChanges: async () => {
      probes++;
      return {
        hasChanges: opts.hasChanges ?? false,
        youngestRevision: 100
      };
    },
    groupManager: {
      remoteChanges: {
        resourceStates: new Array(opts.remoteUiCount ?? 0).fill({})
      }
    },
    run: async () => {
      fullFetches++;
    },
    lastFullRemoteStatusTs: opts.lockSweepFresh ? Date.now() : 0
  };
  const poll = (Repository.prototype as any).pollRemoteChanges;
  return {
    poll: (force = false) => poll.call(mockThis, force),
    counts: () => ({ fullFetches, probes })
  };
}

suite("Two-tier remote poll", () => {
  test("quiet server, empty UI, fresh lock sweep: tick skips full status", async () => {
    const h = await makePollHarness({
      hasChanges: false,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll();
    assert.deepStrictEqual(h.counts(), { fullFetches: 0, probes: 1 });
  });

  test("incoming revisions trigger the full --show-updates fetch", async () => {
    const h = await makePollHarness({
      hasChanges: true,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll();
    assert.strictEqual(h.counts().fullFetches, 1);
  });

  test("lock sweep due forces a periodic full fetch despite quiet server", async () => {
    const h = await makePollHarness({
      hasChanges: false,
      remoteUiCount: 0,
      lockSweepFresh: false
    });
    await h.poll();
    assert.strictEqual(
      h.counts().fullFetches,
      1,
      "locks change without revision bumps - periodic sweep required"
    );
  });

  test("stale incoming-changes UI refreshes even when server is quiet", async () => {
    const h = await makePollHarness({
      hasChanges: false,
      remoteUiCount: 3, // user pulled outside the poll; UI must clear
      lockSweepFresh: true
    });
    await h.poll();
    assert.strictEqual(h.counts().fullFetches, 1);
  });

  test("force bypasses the probe entirely (event-driven refresh)", async () => {
    const h = await makePollHarness({
      hasChanges: false,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll(true);
    assert.deepStrictEqual(h.counts(), { fullFetches: 1, probes: 0 });
  });
});
