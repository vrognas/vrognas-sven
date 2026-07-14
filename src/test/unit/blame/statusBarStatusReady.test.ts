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
    Object.defineProperty(scm, "repositories", { value: [] });
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
    Object.defineProperty(scm, "repositories", { value: [] });
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
    assert.strictEqual(
      (statusBar as any).$debounce$applyStatusBarUpdate,
      undefined
    );
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

  test("does not apply blame for an editor that is no longer active", async () => {
    const clock = sandbox.useFakeTimers();
    const b = {
      document: { uri: Uri.file("/b.ts"), lineCount: 1 },
      selection: { active: { line: 0 } }
    } as any;
    const c = {
      document: { uri: Uri.file("/c.ts"), lineCount: 1 },
      selection: { active: { line: 0 } }
    } as any;
    let active: any;
    sandbox.stub(window, "activeTextEditor").get(() => active);
    statusBar = new BlameStatusBar({ repositories: [] } as any);
    sandbox.stub(statusBar as any, "shouldShowStatusBar").returns(true);
    sandbox
      .stub(statusBar as any, "formatStatusBarText")
      .callsFake((...args: unknown[]) => (args[0] as ISvnBlameLine).author);
    let resolveB!: (value: ISvnBlameLine[]) => void;
    const pendingB = new Promise<ISvnBlameLine[]>(resolve => {
      resolveB = resolve;
    });
    sandbox
      .stub(statusBar as any, "getBlameData")
      .callsFake((...args: unknown[]) =>
        (args[0] as Uri).toString() === b.document.uri.toString()
          ? pendingB
          : Promise.resolve([
              {
                lineNumber: 1,
                revision: "2",
                author: "C",
                date: "2026-01-01"
              }
            ])
      );

    active = b;
    void statusBar.updateStatusBar();
    await clock.tickAsync(150);
    active = c;
    void statusBar.updateStatusBar();
    await clock.tickAsync(150);
    assert.strictEqual((statusBar as any).statusBarItem.text, "C");

    resolveB([
      { lineNumber: 1, revision: "1", author: "B", date: "2026-01-01" }
    ]);
    await Promise.resolve();

    assert.strictEqual((statusBar as any).statusBarItem.text, "C");
  });

  test("does not apply an older result for the same editor and line", async () => {
    const clock = sandbox.useFakeTimers();
    const editor = {
      document: { uri: Uri.file("/file.ts"), lineCount: 1 },
      selection: { active: { line: 0 } }
    } as any;
    sandbox.stub(window, "activeTextEditor").value(editor);
    statusBar = new BlameStatusBar({ repositories: [] } as any);
    sandbox.stub(statusBar as any, "shouldShowStatusBar").returns(true);
    sandbox
      .stub(statusBar as any, "formatStatusBarText")
      .callsFake((...args: unknown[]) => (args[0] as ISvnBlameLine).author);
    let resolveOld!: (value: ISvnBlameLine[]) => void;
    let resolveNew!: (value: ISvnBlameLine[]) => void;
    const oldResult = new Promise<ISvnBlameLine[]>(resolve => {
      resolveOld = resolve;
    });
    const newResult = new Promise<ISvnBlameLine[]>(resolve => {
      resolveNew = resolve;
    });
    const getBlameData = sandbox.stub(statusBar as any, "getBlameData");
    getBlameData.onFirstCall().returns(oldResult);
    getBlameData.onSecondCall().returns(newResult);

    void statusBar.updateStatusBar();
    await clock.tickAsync(150);
    void statusBar.updateStatusBar();
    await clock.tickAsync(150);
    resolveNew([
      { lineNumber: 1, revision: "2", author: "new", date: "2026-01-02" }
    ]);
    await Promise.resolve();
    assert.strictEqual((statusBar as any).statusBarItem.text, "new");

    resolveOld([
      { lineNumber: 1, revision: "1", author: "old", date: "2026-01-01" }
    ]);
    await Promise.resolve();

    assert.strictEqual((statusBar as any).statusBarItem.text, "new");
  });

  test("invalidates in-flight blame when a newer refresh is requested", async () => {
    const clock = sandbox.useFakeTimers();
    const editor = {
      document: { uri: Uri.file("/file.ts"), lineCount: 1 },
      selection: { active: { line: 0 } }
    } as any;
    statusBar = new BlameStatusBar({ repositories: [] } as any);
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(statusBar as any, "shouldShowStatusBar").returns(true);
    sandbox
      .stub(statusBar as any, "formatStatusBarText")
      .callsFake((...args: unknown[]) => (args[0] as ISvnBlameLine).author);
    let resolveOld!: (value: ISvnBlameLine[]) => void;
    const oldResult = new Promise<ISvnBlameLine[]>(resolve => {
      resolveOld = resolve;
    });
    sandbox.stub(statusBar as any, "getBlameData").returns(oldResult);
    (statusBar as any).statusBarItem.text = "current";

    void statusBar.updateStatusBar();
    await clock.tickAsync(150);
    void statusBar.updateStatusBar();
    resolveOld([
      { lineNumber: 1, revision: "1", author: "old", date: "2026-01-01" }
    ]);
    await Promise.resolve();

    assert.strictEqual((statusBar as any).statusBarItem.text, "current");
  });
});
