import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Status } from "../../../common/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

function editorFor(uri: Uri): any {
  return {
    document: {
      uri,
      version: 1,
      lineCount: 2,
      getText: () => "a\nb",
      lineAt: () => ({ range: { end: { character: 1 } } })
    },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  };
}

suite("BlameProvider - owner epoch lifecycle", () => {
  let sandbox: sinon.SinonSandbox;
  let provider: BlameProvider;

  setup(() => (sandbox = sinon.createSandbox()));
  teardown(() => {
    provider?.dispose();
    sandbox.restore();
    delete (window as any).visibleTextEditors;
  });

  test("discards blame returned after its repository stops owning the URI", async () => {
    const uri = Uri.file("/a/file.ts");
    const pending = deferred<any[]>();
    const repoA = {
      workspaceRoot: "/a",
      getResourceFromFile: () => undefined,
      blame: () => pending.promise
    };
    let owner: unknown = repoA;
    provider = new BlameProvider({
      repositories: [repoA],
      getRepositoryFromUri: () => owner
    } as never);

    const result = (provider as any).getBlameData(uri, editorFor(uri), repoA);
    owner = undefined;
    pending.resolve([{ lineNumber: 1, revision: "1", author: "old" }]);

    assert.strictEqual(await result, undefined);
    assert.ok(!(provider as any).blameCache.has(uri.toString()));
  });

  test("late mapping and add-revision work cannot repopulate a closed owner", async () => {
    const uri = Uri.file("/a/file.ts");
    const base = deferred<string>();
    const log = deferred<Array<{ revision: string }>>();
    const repoA = {
      workspaceRoot: "/a",
      getResourceFromFile: () => ({ type: Status.MODIFIED }),
      repository: {
        show: () => base.promise,
        log: () => log.promise
      }
    };
    let owner: unknown = repoA;
    provider = new BlameProvider({
      repositories: [repoA],
      getRepositoryFromUri: () => owner
    } as never);

    const mapping = (provider as any).getLineMapping(
      uri,
      editorFor(uri),
      repoA
    );
    const addRevision = (provider as any).ensureAddRevision(uri);
    owner = undefined;
    base.resolve("a\nb");
    log.resolve([{ revision: "7" }]);
    await Promise.all([mapping, addRevision]);

    const key = uri.toString();
    assert.ok(!(provider as any).lineMappingCache.has(key));
    assert.ok(!(provider as any).addRevisionCache.has(key));
  });

  test("message fetches are isolated when URI ownership changes", async () => {
    const uri = Uri.file("/a/file.ts");
    const oldLog = deferred<Array<{ revision: string; msg: string }>>();
    const repoA = {
      workspaceRoot: "/a",
      logBatch: sandbox.stub().returns(oldLog.promise)
    };
    const repoB = {
      workspaceRoot: "/b",
      logBatch: sandbox.stub().resolves([{ revision: "9", msg: "new message" }])
    };
    let owner: unknown = repoA;
    provider = new BlameProvider({
      repositories: [repoA, repoB],
      getRepositoryFromUri: () => owner
    } as never);

    const editor = editorFor(uri);
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameStateManager, "isBlameEnabled").returns(true);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );
    const oldBlame = [{ lineNumber: 1, revision: "1", author: "old" }];
    const newBlame = [{ lineNumber: 1, revision: "9", author: "new" }];

    const first = (provider as any).prefetchMessagesProgressively(
      uri,
      oldBlame,
      editor
    );
    owner = repoB;
    const second = (provider as any).prefetchMessagesProgressively(
      uri,
      newBlame,
      editor
    );
    oldLog.resolve([{ revision: "1", msg: "old message" }]);
    await Promise.all([first, second]);

    assert.ok(repoB.logBatch.calledOnce, "new owner starts its own fetch");
    assert.strictEqual(
      (provider as any).messageCache.get((provider as any).msgKey("/b", "9")),
      "new message"
    );
    assert.ok(apply.calledOnceWith(newBlame, editor));
  });

  test("progressive messages do not repaint an edited document", async () => {
    const uri = Uri.file("/a/file.ts");
    const pending = deferred<Array<{ revision: string; msg: string }>>();
    const repo = {
      workspaceRoot: "/a",
      logBatch: sandbox.stub().returns(pending.promise)
    };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);

    const editor = editorFor(uri);
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameStateManager, "isBlameEnabled").returns(true);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );

    const fetch = (provider as any).prefetchMessagesProgressively(
      uri,
      [{ lineNumber: 1, revision: "9", author: "old" }],
      editor
    );
    editor.document.version++;
    pending.resolve([{ revision: "9", msg: "message" }]);
    await fetch;

    assert.ok(apply.notCalled);
  });

  test("edited document starts a version-specific message fetch", async () => {
    const uri = Uri.file("/a/file.ts");
    const oldLog = deferred<Array<{ revision: string; msg: string }>>();
    const newLog = deferred<Array<{ revision: string; msg: string }>>();
    const logBatch = sandbox.stub();
    logBatch.onFirstCall().returns(oldLog.promise);
    logBatch.onSecondCall().returns(newLog.promise);
    const repo = { workspaceRoot: "/a", logBatch };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);

    const editor = editorFor(uri);
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameStateManager, "isBlameEnabled").returns(true);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );
    const oldBlame = [{ lineNumber: 1, revision: "8", author: "old" }];
    const newBlame = [{ lineNumber: 1, revision: "9", author: "new" }];

    const first = (provider as any).prefetchMessagesProgressively(
      uri,
      oldBlame,
      editor
    );
    editor.document.version++;
    const second = (provider as any).prefetchMessagesProgressively(
      uri,
      newBlame,
      editor
    );
    newLog.resolve([{ revision: "9", msg: "new message" }]);
    oldLog.resolve([{ revision: "8", msg: "old message" }]);
    await Promise.all([first, second]);

    assert.ok(logBatch.calledTwice, "new version starts an independent fetch");
    assert.ok(apply.calledOnceWith(newBlame, editor));
  });

  test("progressive messages repaint an inactive visible editor", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = {
      workspaceRoot: "/a",
      logBatch: sandbox.stub().resolves([{ revision: "9", msg: "new message" }])
    };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);

    const editor = editorFor(uri);
    const active = editorFor(Uri.file("/a/active.ts"));
    sandbox.stub(window, "activeTextEditor").value(active);
    (window as any).visibleTextEditors = [active, editor];
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameStateManager, "isBlameEnabled").returns(true);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );
    const blame = [{ lineNumber: 1, revision: "9", author: "new" }];

    await (provider as any).prefetchMessagesProgressively(uri, blame, editor);

    assert.ok(apply.calledOnceWith(blame, editor));
  });

  test("shared message fetch applies to every visible split", async () => {
    const uri = Uri.file("/a/file.ts");
    const pending = deferred<Array<{ revision: string; msg: string }>>();
    const repo = {
      workspaceRoot: "/a",
      logBatch: sandbox.stub().returns(pending.promise)
    };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);

    const firstEditor = editorFor(uri);
    const secondEditor = editorFor(uri);
    sandbox.stub(window, "activeTextEditor").value(firstEditor);
    (window as any).visibleTextEditors = [firstEditor, secondEditor];
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameStateManager, "isBlameEnabled").returns(true);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );
    const blame = [{ lineNumber: 1, revision: "9", author: "new" }];

    const first = (provider as any).prefetchMessagesProgressively(
      uri,
      blame,
      firstEditor
    );
    const second = (provider as any).prefetchMessagesProgressively(
      uri,
      blame,
      secondEditor
    );
    pending.resolve([{ revision: "9", msg: "message" }]);
    await Promise.all([first, second]);

    assert.ok(repo.logBatch.calledOnce, "network fetch remains deduplicated");
    assert.ok(apply.calledWith(blame, firstEditor));
    assert.ok(apply.calledWith(blame, secondEditor));
  });
});
