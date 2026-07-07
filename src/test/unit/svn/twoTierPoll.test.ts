import * as assert from "assert";

async function makePollHarness(opts: {
  hasChanges?: boolean;
  youngestRevision?: number;
  lastFullFetchRevision?: number;
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
        youngestRevision: opts.youngestRevision ?? 100
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
    _lastRemoteStatusRevision: opts.lastFullFetchRevision,
    lastFullRemoteStatusTs: opts.lockSweepFresh ? Date.now() : 0
  };
  const poll = (Repository.prototype as any).pollRemoteChanges;
  return {
    poll: (force = false) => poll.call(mockThis, force),
    counts: () => ({ fullFetches, probes }),
    state: mockThis
  };
}

suite("Two-tier remote poll", () => {
  test("unchanged revision, empty UI, fresh lock sweep: tick skips full status", async () => {
    const h = await makePollHarness({
      youngestRevision: 100,
      lastFullFetchRevision: 100,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll();
    assert.deepStrictEqual(h.counts(), { fullFetches: 0, probes: 1 });
  });

  test("new revision since last full fetch triggers the full fetch", async () => {
    const h = await makePollHarness({
      hasChanges: true,
      youngestRevision: 108,
      lastFullFetchRevision: 100,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll();
    assert.strictEqual(h.counts().fullFetches, 1);
    assert.strictEqual(
      h.state._lastRemoteStatusRevision,
      108,
      "successful full fetch re-anchors the gate"
    );
  });

  test("gate uses revision identity, not youngest>BASE (mixed-rev WCs)", async () => {
    // Own root-node commit: probe computes hasChanges=false (youngest ==
    // BASE) but the revision MOVED since the last full fetch - a
    // colleague's r103 may hide between them. Must fetch.
    const h = await makePollHarness({
      hasChanges: false,
      youngestRevision: 106,
      lastFullFetchRevision: 100,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll();
    assert.strictEqual(
      h.counts().fullFetches,
      1,
      "hasChanges lies in mixed-revision WCs - gate on revision identity"
    );
  });

  test("unanchored gate (after force refresh) runs the full fetch", async () => {
    const h = await makePollHarness({
      youngestRevision: 100,
      lastFullFetchRevision: undefined,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll();
    assert.strictEqual(h.counts().fullFetches, 1);
  });

  test("lock sweep due forces a periodic full fetch despite quiet server", async () => {
    const h = await makePollHarness({
      youngestRevision: 100,
      lastFullFetchRevision: 100,
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
      youngestRevision: 100,
      lastFullFetchRevision: 100,
      remoteUiCount: 3, // user pulled outside the poll; UI must clear
      lockSweepFresh: true
    });
    await h.poll();
    assert.strictEqual(h.counts().fullFetches, 1);
  });

  test("force bypasses the probe and un-anchors the gate", async () => {
    const h = await makePollHarness({
      youngestRevision: 100,
      lastFullFetchRevision: 100,
      remoteUiCount: 0,
      lockSweepFresh: true
    });
    await h.poll(true);
    assert.deepStrictEqual(h.counts(), { fullFetches: 1, probes: 0 });
    assert.strictEqual(
      h.state._lastRemoteStatusRevision,
      undefined,
      "force refresh leaves the gate unanchored - next tick re-anchors"
    );
  });
});
