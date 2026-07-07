import * as assert from "assert";
import * as sinon from "sinon";
import { Uri } from "vscode";
import { toSvnUri } from "../../../uri";
import { SvnUriAction } from "../../../common/types";

const INFO = {
  commit: {
    revision: "42",
    author: "alice",
    date: "2026-01-02T00:00:00.000000Z"
  }
};

function makeMockRepo(sandbox: sinon.SinonSandbox) {
  return {
    statusReady: Promise.resolve(),
    getResourceFromFile: sandbox.stub().returns(undefined),
    isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined),
    getInfo: sandbox.stub().resolves(INFO),
    list: sandbox
      .stub()
      .resolves([
        { size: "100", commit: { date: "2026-03-03T00:00:00.000000Z" } }
      ])
  };
}

async function makeProvider(mockRepo: any) {
  const { SvnFileSystemProvider } = await import(
    "../../../svnFileSystemProvider"
  );
  const provider: any = Object.create(SvnFileSystemProvider.prototype);
  provider.sourceControlManager = {
    isInitialized: Promise.resolve(),
    getRepository: () => mockRepo
  };
  return provider;
}

suite("SvnFileSystemProvider stat", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test("quickdiff original stat uses local info, never remote list", async () => {
    const mockRepo = makeMockRepo(sandbox);
    const provider = await makeProvider(mockRepo);
    // provideOriginalResource shape: SHOW with no ref (BASE)
    const uri = toSvnUri(Uri.file("/test/a.txt"), SvnUriAction.SHOW, {});

    const stat = await provider.doStat(uri);

    assert.ok(
      mockRepo.list.notCalled,
      "stat must not spawn a remote `svn list <URL>` round-trip"
    );
    assert.strictEqual(
      stat.mtime,
      Date.parse(INFO.commit.date),
      "mtime must come from the local BASE last-changed date"
    );
  });

  test("revision-pinned URIs get a stable stat with no svn calls", async () => {
    const mockRepo = makeMockRepo(sandbox);
    const provider = await makeProvider(mockRepo);
    const uri = toSvnUri(Uri.file("/test/a.txt"), SvnUriAction.SHOW, {
      ref: "123"
    });

    const stat = await provider.doStat(uri);

    assert.ok(mockRepo.list.notCalled, "no remote list for pinned revisions");
    assert.ok(
      mockRepo.getInfo.notCalled,
      "pinned content is immutable - no info needed"
    );
    assert.strictEqual(stat.mtime, 0, "stable mtime prevents re-reads");
  });

  test("mtime tracks BASE so commits still trigger reloads", async () => {
    const mockRepo = makeMockRepo(sandbox);
    const provider = await makeProvider(mockRepo);
    const uri = toSvnUri(Uri.file("/test/a.txt"), SvnUriAction.SHOW, {});

    const before = await provider.doStat(uri);

    // Commit bumps BASE - last-changed date moves
    mockRepo.getInfo.resolves({
      commit: { ...INFO.commit, date: "2026-02-02T00:00:00.000000Z" }
    });
    const after = await provider.doStat(uri);

    assert.notStrictEqual(
      before.mtime,
      after.mtime,
      "changed BASE must produce a changed mtime (drives VS Code reload)"
    );
  });
});
