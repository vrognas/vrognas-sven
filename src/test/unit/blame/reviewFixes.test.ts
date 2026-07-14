import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { vi } from "vitest";
import { EventEmitter, Uri, window } from "vscode";
import { Operation, RepositoryState } from "../../../common/types";
import { BlameProvider } from "../../../blame/blameProvider";
import { BlameStatusBar } from "../../../blame/blameStatusBar";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Repository } from "../../../repository";
import { SourceControlManager } from "../../../source_control_manager";
import { ISvnBlameLine } from "../../../common/types";

import { BLAME_XML, makeFakeSvnRepo } from "../svn/helpers/fakeSvnRepository";

const BLAME_DATA: ISvnBlameLine[] = [
  {
    lineNumber: 1,
    revision: "123",
    author: "john",
    date: "2025-11-18T10:00:00Z"
  }
];

suite("Blame review fixes", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test("in-flight blame cannot repopulate a cleared cache", async () => {
    const { repo, getCount, setExec } = await makeFakeSvnRepo();

    let release!: () => void;
    setExec(
      () =>
        new Promise(resolve => {
          release = () => resolve({ stdout: BLAME_XML });
        })
    );
    const pending = repo.blame("file.txt");
    // Let the sequentialized fetch reach exec before invalidating
    await new Promise(r => setTimeout(r, 10));

    // Mutating op (commit) invalidates while the fetch is in flight
    repo.clearBlameCache();

    release();
    await pending;

    assert.strictEqual(
      repo._blameCache.get("file.txt@BASE"),
      undefined,
      "pre-mutation result must not repopulate the cleared cache"
    );

    setExec(async () => ({ stdout: BLAME_XML }));
    await repo.blame("file.txt");
    assert.strictEqual(getCount(), 2, "post-clear blame must re-fetch");
  });

  test("skipCache=true forces a fresh fetch despite warm cache", async () => {
    const { repo, getCount } = await makeFakeSvnRepo();

    await repo.blame("file.txt");
    await repo.blame("file.txt", "BASE", true);

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

    const provider = new BlameProvider(scmFor(mockRepository as any));
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
    Object.defineProperty(scm, "repositories", { value: [] });
    scm.getRepositoryFromUri.returns(mockRepo as any);

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

  test("status bar refreshes after a mutating op despite same-line skip", async () => {
    const testUri = Uri.file("/test/file.txt");
    blameStateManager.setBlameEnabled(testUri, true);

    const opEmitter = new EventEmitter<Operation>();
    const mockRepo = {
      blame: sandbox.stub().resolves(BLAME_DATA),
      statusReady: Promise.resolve(),
      getResourceFromFile: sandbox.stub().returns(undefined),
      isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined),
      onDidRunOperation: opEmitter.event
    };
    const scm: any = {
      getRepositoryFromUri: () => mockRepo,
      repositories: [mockRepo],
      onDidOpenRepository: new EventEmitter<unknown>().event
    };

    const statusBar = new BlameStatusBar(scm);
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
      fire(); // same line, successful render - must be skipped
      await new Promise(r => setTimeout(r, 400));
      assert.strictEqual(mockRepo.blame.callCount, 1, "same-line skip holds");

      // Commit changes BASE - status bar must refresh without cursor moving
      opEmitter.fire(Operation.Commit);
      await new Promise(r => setTimeout(r, 400));

      assert.strictEqual(
        mockRepo.blame.callCount,
        2,
        "mutating op must refresh the status bar for the pinned line"
      );
    } finally {
      statusBar.dispose();
    }
  });

  test("E155007 blame failures are silent and carry the code", async () => {
    // svnRepository layer: rewrapped message must keep the error code so
    // callers' silent-skip checks can match it
    const { repo, setExec } = await makeFakeSvnRepo();
    setExec(() =>
      Promise.reject({ stderr: "svn: E155007: '/x' is not a working copy" })
    );
    await assert.rejects(repo.blame("outside.txt"), /E155007/);

    // provider layer: such errors must not reach logError (silent skip,
    // matching the old svn-info pre-check behavior for non-WC files)
    const errorLogger = await import("../../../util/errorLogger");
    const logSpy = vi
      .spyOn(errorLogger, "logError")
      .mockImplementation(() => {});
    try {
      const mockRepository = sandbox.createStubInstance(Repository);
      (mockRepository as any).repository = {
        workspaceRoot: "/test",
        root: "/test"
      };
      mockRepository.getResourceFromFile.returns(undefined as any);
      mockRepository.blame.rejects(
        new Error("File not under version control (E155007): outside.txt")
      );
      const provider = new BlameProvider(scmFor(mockRepository as any));
      try {
        const uri = Uri.file("/test/outside.txt");
        const editor = { document: { uri, version: 1 } } as any;
        const result = await (provider as any).getBlameData(uri, editor);
        assert.strictEqual(result, undefined);
        assert.strictEqual(
          logSpy.mock.calls.length,
          0,
          "E155007 must be skipped silently, not logged"
        );
      } finally {
        provider.dispose();
      }
    } finally {
      logSpy.mockRestore();
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
