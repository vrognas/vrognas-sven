import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameStatusBar } from "../../../blame/blameStatusBar";
import { SourceControlManager } from "../../../source_control_manager";
import { ISvnBlameLine } from "../../../common/types";

suite("BlameStatusBar - initial status crawl", () => {
  let statusBar: BlameStatusBar;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    statusBar?.dispose();
    sandbox.restore();
  });

  test("does not block blame lookup on the initial status crawl", async () => {
    const uri = Uri.file("/test/file.ts");
    const blame: ISvnBlameLine[] = [
      { lineNumber: 1, revision: "1", author: "a", date: "2026-01-01" }
    ];
    const repo = {
      root: "/test",
      workspaceRoot: "/test",
      statusReady: new Promise<void>(() => {}), // never resolves (crawl in progress)
      getResourceFromFile: sandbox.stub().returns(undefined),
      isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined),
      blame: sandbox.stub().resolves(blame)
    };
    const scm = sandbox.createStubInstance(SourceControlManager);
    (scm as any).openRepositories = [];
    scm.getRepositoryFromUri.returns(repo as any);

    statusBar = new BlameStatusBar(scm as any);

    const result = await Promise.race([
      (statusBar as any).getBlameData(uri),
      new Promise(resolve => setTimeout(() => resolve("TIMEOUT"), 150))
    ]);

    assert.notStrictEqual(
      result,
      "TIMEOUT",
      "getBlameData must not await the initial status crawl"
    );
    assert.ok(repo.blame.called, "blame is attempted immediately");
  });

  test("keeps blaming an svn:external after status crawl", async () => {
    const uri = Uri.file("/test/vendor/file.ts");
    const blame: ISvnBlameLine[] = [
      { lineNumber: 1, revision: "42", author: "a", date: "2026-01-01" }
    ];
    const repo = {
      getResourceFromFile: sandbox.stub().returns(undefined),
      isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined),
      blame: sandbox.stub().resolves(blame)
    };
    const scm = sandbox.createStubInstance(SourceControlManager);
    (scm as any).openRepositories = [];
    scm.getRepository.returns(null);
    scm.getRepositoryFromUri.returns(repo as any);

    statusBar = new BlameStatusBar(scm as any);

    const result = await (statusBar as any).getBlameData(uri);

    assert.deepStrictEqual(result, blame);
    assert.ok(scm.getRepositoryFromUri.calledOnceWith(uri));
    assert.ok(scm.getRepository.notCalled);
  });

  test("ignores status completion after disposal", async () => {
    let resolveStatus!: () => void;
    const repo = {
      workspaceRoot: "/test",
      statusReady: new Promise<void>(resolve => {
        resolveStatus = resolve;
      })
    };
    const scm = { repositories: [repo] };

    statusBar = new BlameStatusBar(scm as any);
    const updateStatusBar = sandbox.spy(statusBar, "updateStatusBar");
    void statusBar.updateStatusBar();

    statusBar.dispose();
    resolveStatus();
    await Promise.resolve();

    assert.strictEqual(updateStatusBar.callCount, 1);
    assert.strictEqual((statusBar as any).$debounce$updateStatusBar, undefined);
  });

  test("drops an in-flight status update after disposal", async () => {
    const clock = sandbox.useFakeTimers();
    const uri = Uri.file("/test/file.ts");
    const editor = {
      document: { uri, lineCount: 1 },
      selection: { active: { line: 0 } }
    };
    let resolveBlame!: (value: undefined) => void;
    const pendingBlame = new Promise<undefined>(resolve => {
      resolveBlame = resolve;
    });

    statusBar = new BlameStatusBar({ repositories: [] } as any);
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(statusBar as any, "shouldShowStatusBar").returns(true);
    sandbox.stub(statusBar as any, "getBlameData").returns(pendingBlame);
    const showUncommitted = sandbox.stub(
      statusBar as any,
      "showUncommittedStatus"
    );

    void statusBar.updateStatusBar();
    await clock.tickAsync(150);
    statusBar.dispose();
    resolveBlame(undefined);
    await Promise.resolve();

    assert.ok(showUncommitted.notCalled);
  });
});
