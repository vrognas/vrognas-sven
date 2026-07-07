import * as assert from "assert";
import * as sinon from "sinon";
import { EventEmitter, Uri, window } from "vscode";
import { LRUCache } from "../../../util/lruCache";
import { Operation, RepositoryState } from "../../../common/types";
import { BlameProvider } from "../../../blame/blameProvider";
import { BlameStatusBar } from "../../../blame/blameStatusBar";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Repository } from "../../../repository";
import { SourceControlManager } from "../../../source_control_manager";
import { ISvnBlameLine } from "../../../common/types";

const BLAME_XML = `<?xml version="1.0"?>
<blame>
  <target path="file.txt">
    <entry line-number="1">
      <commit revision="123">
        <author>john</author>
        <date>2025-11-18T10:00:00.000000Z</date>
      </commit>
    </entry>
  </target>
</blame>`;

const BLAME_DATA: ISvnBlameLine[] = [
  {
    lineNumber: 1,
    revision: "123",
    author: "john",
    date: "2025-11-18T10:00:00Z"
  }
];

function makeSvnRepo() {
  let execCount = 0;
  let execImpl: () => Promise<{ stdout: string }> = async () => ({
    stdout: BLAME_XML
  });
  const repo: any = Object.create(null);
  repo.removeAbsolutePath = (p: string) => p;
  repo.exec = async (_args: string[]) => {
    execCount++;
    return execImpl();
  };
  repo._blameCache = new LRUCache(100, 5 * 60 * 1000);
  repo._blameInFlight = new Map();
  repo._blameErrorCache = new LRUCache(50, 30 * 1000);
  repo._blameGeneration = 0;
  return {
    repo,
    getCount: () => execCount,
    setExec: (impl: typeof execImpl) => (execImpl = impl)
  };
}

suite("Blame review fixes", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test("in-flight blame cannot repopulate a cleared cache", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo, getCount, setExec } = makeSvnRepo();
    Object.setPrototypeOf(repo, SvnRepository.prototype);

    let release!: () => void;
    setExec(
      () =>
        new Promise(resolve => {
          release = () => resolve({ stdout: BLAME_XML });
        })
    );
    const pending = SvnRepository.prototype.blame.call(repo, "file.txt");
    // Let the sequentialized fetch reach exec before invalidating
    await new Promise(r => setTimeout(r, 10));

    // Mutating op (commit) invalidates while the fetch is in flight
    (SvnRepository.prototype as any).clearBlameCache.call(repo);

    release();
    await pending;

    assert.strictEqual(
      repo._blameCache.get("file.txt@BASE"),
      undefined,
      "pre-mutation result must not repopulate the cleared cache"
    );

    setExec(async () => ({ stdout: BLAME_XML }));
    await SvnRepository.prototype.blame.call(repo, "file.txt");
    assert.strictEqual(getCount(), 2, "post-clear blame must re-fetch");
  });

  test("skipCache=true forces a fresh fetch despite warm cache", async () => {
    const { Repository: SvnRepository } = await import(
      "../../../svnRepository"
    );
    const { repo, getCount } = makeSvnRepo();
    Object.setPrototypeOf(repo, SvnRepository.prototype);

    await SvnRepository.prototype.blame.call(repo, "file.txt");
    await SvnRepository.prototype.blame.call(repo, "file.txt", "BASE", true);

    assert.strictEqual(getCount(), 2, "skipCache must bypass the cache");
  });

  test("provider drops its cache and refreshes on mutating ops", async () => {
    const mockRepository = sandbox.createStubInstance(Repository);
    (mockRepository as any).repository = {
      workspaceRoot: "/test",
      root: "/test"
    };
    const opEmitter = new EventEmitter<Operation>();
    (mockRepository as any).onDidRunOperation = opEmitter.event;

    const provider = new BlameProvider(mockRepository as any);
    try {
      sandbox.stub(window, "activeTextEditor").value(undefined);
      provider.activate();

      (provider as any).blameCache.set("file:///test/a.txt", {
        data: BLAME_DATA,
        version: 1
      });

      opEmitter.fire(Operation.Commit);

      assert.strictEqual(
        (provider as any).blameCache.size,
        0,
        "commit must drop the provider blame cache (version is unchanged)"
      );

      (provider as any).blameCache.set("file:///test/a.txt", {
        data: BLAME_DATA,
        version: 1
      });
      opEmitter.fire(Operation.Blame);
      assert.strictEqual(
        (provider as any).blameCache.size,
        1,
        "read-only ops must not drop the cache"
      );
    } finally {
      provider.dispose();
    }
  });

  test("status bar retries same-line after a transient blame failure", async () => {
    const testUri = Uri.file("/test/file.txt");
    blameStateManager.setBlameEnabled(testUri, true);

    const blameStub = sandbox.stub();
    blameStub.onCall(0).rejects(new Error("svn: E155004: locked"));
    blameStub.onCall(1).resolves(BLAME_DATA);
    const mockRepo = {
      blame: blameStub,
      statusReady: Promise.resolve(),
      getResourceFromFile: sandbox.stub().returns(undefined),
      isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined)
    };
    const scm = sandbox.createStubInstance(SourceControlManager);
    scm.getRepository.returns(mockRepo as any);

    const statusBar = new BlameStatusBar(scm as any);
    try {
      const mockEditor = {
        document: { uri: testUri, lineCount: 5, version: 1 },
        selection: { active: { line: 0 } }
      } as any;
      sandbox.stub(window, "activeTextEditor").value(mockEditor);

      const fire = () =>
        (statusBar as any).onSelectionChanged({ textEditor: mockEditor });

      fire();
      await new Promise(r => setTimeout(r, 400));
      fire(); // same line - must retry because the last attempt failed
      await new Promise(r => setTimeout(r, 400));

      assert.strictEqual(
        blameStub.callCount,
        2,
        "failed blame must not be pinned by the same-line skip"
      );
    } finally {
      statusBar.dispose();
    }
  });

  test("Repository.run clears blame cache even when the op fails", async () => {
    const { Repository: RepoFacade } = await import("../../../repository");

    let cleared = 0;
    const mockThis: any = {
      state: RepositoryState.Idle,
      workspaceRoot: ".",
      repository: {
        clearBlameCache: () => {
          cleared++;
        }
      },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async () => {},
      lastForceRefresh: 0
    };

    const run = (RepoFacade.prototype as any).run;
    await assert.rejects(
      run.call(mockThis, Operation.Update, async () => {
        throw new Error("E155004: working copy locked");
      })
    );
    assert.strictEqual(
      cleared,
      1,
      "failed update may still have mutated the WC - cache must clear"
    );
  });
});
