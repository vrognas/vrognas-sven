import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Status } from "../../../common/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
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
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
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
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
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

  test("progressive messages do not repaint after blame becomes ineligible", async () => {
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
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameStateManager, "isBlameEnabled").returns(true);
    let eligible = true;
    sandbox.stub(provider as any, "shouldDecorate").callsFake(() => eligible);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );
    const clear = sandbox.stub(provider, "clearDecorations");

    const fetch = (provider as any).prefetchMessagesProgressively(
      uri,
      [{ lineNumber: 1, revision: "9", author: "old" }],
      editor
    );
    eligible = false;
    pending.resolve([{ revision: "9", msg: "message" }]);
    await fetch;

    assert.ok(apply.notCalled);
    assert.ok(clear.calledOnceWith(editor));
  });

  test("progressive messages do not repaint after a late size gate", async () => {
    const uri = Uri.file("/a/file.csv");
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
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameStateManager, "isBlameEnabled").returns(true);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    let sizeGate: "csv" | undefined = undefined;
    sandbox
      .stub(blameConfiguration, "getBlameSizeGate")
      .callsFake(() => sizeGate);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );
    const clear = sandbox.stub(provider, "clearDecorations");

    const fetch = (provider as any).prefetchMessagesProgressively(
      uri,
      [{ lineNumber: 1, revision: "9", author: "old" }],
      editor
    );
    sizeGate = "csv";
    pending.resolve([{ revision: "9", msg: "message" }]);
    await fetch;

    assert.ok(apply.notCalled);
    assert.ok(clear.calledOnceWith(editor));
  });

  test("progressive messages do not repaint after inline messages are disabled", async () => {
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
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    let showMessage = true;
    sandbox
      .stub(blameConfiguration, "shouldShowInlineMessage")
      .callsFake(() => showMessage);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );

    const fetch = (provider as any).prefetchMessagesProgressively(
      uri,
      [{ lineNumber: 1, revision: "9", author: "old" }],
      editor
    );
    showMessage = false;
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
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
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
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
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
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
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

  test("edit debounce keeps independent URI cleanups", async () => {
    const first = editorFor(Uri.file("/a/first.ts"));
    const second = editorFor(Uri.file("/b/second.ts"));
    provider = new BlameProvider({ repositories: [] } as never);
    (window as any).visibleTextEditors = [first, second];
    sandbox.stub(window, "activeTextEditor").value(first);
    const clear = sandbox.stub(provider, "clearDecorations");
    const clock = sandbox.useFakeTimers();

    (provider as any).onDocumentChange({ document: first.document });
    await clock.tickAsync(100);
    (provider as any).onDocumentChange({ document: second.document });
    await clock.tickAsync(400);

    assert.ok(clear.calledOnceWith(first), "second URI must not cancel first");
    await clock.tickAsync(100);
    assert.ok(clear.calledWith(second));
  });

  test("edit cleanup does not cross repository ownership", async () => {
    const uri = Uri.file("/wc/nested/file.ts");
    const editor = editorFor(uri);
    provider = new BlameProvider({ repositories: [] } as never);
    const internals = provider as any;
    internals.claimOwner(uri, { workspaceRoot: "/wc" });
    (window as any).visibleTextEditors = [editor];
    const clear = sandbox.stub(provider, "clearDecorations");
    const clock = sandbox.useFakeTimers();

    internals.onDocumentChange({ document: editor.document });
    internals.claimOwner(uri, { workspaceRoot: "/wc/nested" });
    await clock.tickAsync(500);

    assert.ok(clear.notCalled);
  });

  test("save cancels pending edit cleanup for its URI", async () => {
    const editor = editorFor(Uri.file("/a/file.ts"));
    provider = new BlameProvider({ repositories: [] } as never);
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(window, "activeTextEditor").value(editor);
    const clear = sandbox.stub(provider, "clearDecorations");
    sandbox.stub(provider, "clearCache");
    sandbox.stub(provider as any, "renderVisibleEditors").resolves(undefined);
    const clock = sandbox.useFakeTimers();

    (provider as any).onDocumentChange({ document: editor.document });
    await (provider as any).onDocumentSave(editor.document);
    await clock.tickAsync(500);

    assert.ok(clear.notCalled, "late edit timer must not erase saved render");
  });

  test("cursor debounce and line state stay per visible editor", async () => {
    const first = editorFor(Uri.file("/a/first.ts"));
    const second = editorFor(Uri.file("/b/second.ts"));
    first.selection.active.line = 1;
    second.selection.active.line = 1;
    provider = new BlameProvider({ repositories: [] } as never);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    const update = sandbox
      .stub(provider as any, "updateInlineDecorationsForCursor")
      .resolves(undefined);
    const clock = sandbox.useFakeTimers();

    (provider as any).onCursorPositionChange({ textEditor: first });
    await clock.tickAsync(50);
    (provider as any).onCursorPositionChange({ textEditor: second });
    await clock.tickAsync(150);

    assert.ok(update.calledWith(first), "first split keeps its cursor update");
    assert.ok(
      update.calledWith(second),
      "same line in second split still updates"
    );
  });

  test("cursor rendering honors message visibility settings", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = { workspaceRoot: "/a" };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const editor = editorFor(uri);
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    let showMessage = false;
    let logsEnabled = true;
    sandbox
      .stub(blameConfiguration, "shouldShowInlineMessage")
      .callsFake(() => showMessage);
    sandbox
      .stub(blameConfiguration, "isLogsEnabled")
      .callsFake(() => logsEnabled);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    const blameLine = { lineNumber: 1, revision: "1", author: "dev" };
    sandbox.stub(provider as any, "getBlameData").resolves([blameLine]);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);
    (provider as any).messageCache.set(
      (provider as any).msgKey("/a", "1"),
      "must stay hidden"
    );
    const format = sandbox
      .stub(provider as any, "formatInlineText")
      .returns("inline");

    await (provider as any).updateInlineDecorationsForCursor(editor);
    assert.ok(format.calledWith(blameLine, ""));

    format.resetHistory();
    showMessage = true;
    logsEnabled = false;
    await (provider as any).updateInlineDecorationsForCursor(editor);
    assert.ok(format.calledWith(blameLine, ""));
  });

  test("logs disabled builds no-message inline in phase one", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = { workspaceRoot: "/a" };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const editor = editorFor(uri);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(false);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    const format = sandbox
      .stub(provider as any, "formatInlineText")
      .returns("inline");
    const blameLine = { lineNumber: 1, revision: "1", author: "dev" };

    const decorations = await (provider as any).createAllDecorations(
      [blameLine],
      editor,
      { skipMessagePrefetch: true }
    );

    assert.strictEqual(decorations.inline.length, 1);
    assert.ok(format.calledWith(blameLine, ""));
  });

  test("older phase-two fetch cannot repaint after a newer full render", async () => {
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
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    const apply = sandbox.stub(
      provider as any,
      "updateInlineDecorationsWithMessages"
    );
    (provider as any).renderGenerations.set(editor, 1);

    const fetch = (provider as any).prefetchMessagesProgressively(
      uri,
      [{ lineNumber: 1, revision: "1", author: "dev" }],
      editor,
      undefined,
      undefined,
      undefined,
      1
    );
    (provider as any).renderGenerations.set(editor, 2);
    pending.resolve([{ revision: "1", msg: "old" }]);
    await fetch;

    assert.ok(apply.notCalled);
  });

  test("cursor fetch cannot repaint after a newer full render starts", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = { workspaceRoot: "/a" };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const editor = editorFor(uri);
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    const data = deferred<any[]>();
    sandbox.stub(provider as any, "getBlameData").returns(data.promise);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);

    const update = (provider as any).updateInlineDecorationsForCursor(editor);
    (provider as any).renderGenerations.set(editor, 1);
    data.resolve([{ lineNumber: 1, revision: "1", author: "dev" }]);
    await update;

    assert.ok(editor.setDecorations.notCalled);
  });

  test("message writes invalidate only their repo's dependent render cache", async () => {
    const uriA = Uri.file("/a/file.ts");
    const uriB = Uri.file("/b/file.ts");
    const repoA = {
      workspaceRoot: "/a",
      getResourceFromFile: () => undefined,
      isInsideUnversionedOrIgnored: () => undefined,
      log: sandbox.stub().resolves([{ revision: "1", msg: "new message" }])
    };
    const repoB = {
      workspaceRoot: "/b",
      getResourceFromFile: () => undefined,
      isInsideUnversionedOrIgnored: () => undefined,
      log: sandbox.stub()
    };
    provider = new BlameProvider({
      repositories: [repoA, repoB],
      getRepositoryFromUri: (uri: Uri) =>
        uri.fsPath.startsWith("/a") ? repoA : repoB
    } as never);
    const editorA = editorFor(uriA);
    const editorB = editorFor(uriB);
    (window as any).visibleTextEditors = [editorA, editorB];
    sandbox.stub(window, "activeTextEditor").value(editorA);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(false);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    sandbox
      .stub(provider as any, "getBlameData")
      .resolves([{ lineNumber: 1, revision: "1", author: "dev" }]);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);
    const build = sandbox
      .stub(provider as any, "createAllDecorations")
      .resolves({ gutter: [], icon: [], inline: [] });
    sandbox.stub(provider as any, "applyIconDecorations");
    sandbox.stub(provider as any, "ensureAddRevision").resolves(false);
    sandbox.stub(provider as any, "prefetchPeekData").resolves(undefined);

    await (provider as any).renderDecorations(editorA, true);
    await (provider as any).renderDecorations(editorB, true);
    await (provider as any).getCommitMessage("1", uriA);
    await (provider as any).renderDecorations(editorA, true);
    await (provider as any).renderDecorations(editorB, true);

    assert.strictEqual(build.callCount, 3);
    assert.strictEqual(
      build
        .getCalls()
        .filter((call: sinon.SinonSpyCall) => call.args[1] === editorA).length,
      2
    );
    assert.strictEqual(
      build
        .getCalls()
        .filter((call: sinon.SinonSpyCall) => call.args[1] === editorB).length,
      1
    );
  });

  test("slow repo activation does not block another visible repo", async () => {
    const first = editorFor(Uri.file("/a/first.ts"));
    const second = editorFor(Uri.file("/b/second.ts"));
    const repoA = { workspaceRoot: "/a" };
    const repoB = { workspaceRoot: "/b" };
    provider = new BlameProvider({
      repositories: [repoA, repoB],
      getRepositoryFromUri: (uri: Uri) =>
        uri.fsPath.includes("first") ? repoA : repoB
    } as never);
    let active = first;
    sandbox.stub(window, "activeTextEditor").get(() => active);
    (window as any).visibleTextEditors = [first, second];
    const pending = deferred<void>();
    const render = sandbox.stub(provider as any, "renderDecorations");
    render.onFirstCall().returns(pending.promise);
    render.callsFake(async () => undefined);

    const initial = (provider as any).onActiveEditorChange(first);
    active = second;
    const otherRepo = (provider as any).onActiveEditorChange(second);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      render.calledWith(second, true),
      "repo B must start while repo A is pending"
    );

    active = first;
    const rerun = (provider as any).onActiveEditorChange(first);
    pending.resolve(undefined);
    await Promise.all([initial, otherRepo, rerun]);

    assert.ok(
      render.withArgs(first, true).calledTwice,
      "repeat activation coalesces to one repo-A rerun"
    );
  });

  test("global repaint starts each repository independently", async () => {
    const first = editorFor(Uri.file("/a/first.ts"));
    const second = editorFor(Uri.file("/b/second.ts"));
    const repoA = { workspaceRoot: "/a" };
    const repoB = { workspaceRoot: "/b" };
    provider = new BlameProvider({
      repositories: [repoA, repoB],
      getRepositoryFromUri: (uri: Uri) =>
        uri.fsPath.includes("first") ? repoA : repoB
    } as never);
    (window as any).visibleTextEditors = [first, second];
    sandbox.stub(window, "activeTextEditor").value(first);
    sandbox.stub(provider, "clearDecorations");
    const pending = deferred<void>();
    const render = sandbox.stub(provider as any, "renderDecorations");
    render.withArgs(first, true).returns(pending.promise);
    render.withArgs(second, true).resolves(undefined);

    const repaint = (provider as any).onBlameStateChange(undefined);
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(
      render.calledWith(second, true),
      "repo B must start while repo A is pending"
    );
    pending.resolve(undefined);
    await repaint;
  });

  test("disposed bulk render cannot start its next editor", async () => {
    const first = editorFor(Uri.file("/a/first.ts"));
    const second = editorFor(Uri.file("/b/second.ts"));
    provider = new BlameProvider({ repositories: [] } as never);
    (window as any).visibleTextEditors = [first, second];
    sandbox.stub(window, "activeTextEditor").value(first);
    const pending = deferred<void>();
    const render = sandbox.stub(provider as any, "renderDecorations");
    render.onFirstCall().returns(pending.promise);
    render.onSecondCall().resolves(undefined);

    const bulk = (provider as any).renderVisibleEditors([first, second]);
    await Promise.resolve();
    provider.dispose();
    pending.resolve(undefined);
    await bulk;

    assert.ok(render.calledOnce, "dispose must stop the bulk continuation");
    provider = undefined as any;
  });

  test("stale same-version failed render cannot clear a newer paint", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = {
      workspaceRoot: "/a",
      getResourceFromFile: () => undefined,
      isInsideUnversionedOrIgnored: () => undefined
    };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const editor = editorFor(uri);
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(window, "activeTextEditor").value(editor);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox
      .stub(provider as any, "getBlameData")
      .resolves([{ lineNumber: 1, revision: "1", author: "dev" }]);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);
    const staleBuild = deferred<any>();
    const build = sandbox.stub(provider as any, "createAllDecorations");
    build.onFirstCall().returns(staleBuild.promise);
    build.onSecondCall().resolves({ gutter: [{}], icon: [], inline: [] });
    sandbox.stub(provider as any, "applyIconDecorations");
    sandbox.stub(provider as any, "ensureAddRevision").resolves(false);
    sandbox.stub(provider as any, "prefetchPeekData").resolves(undefined);

    const staleRender = (provider as any).renderDecorations(editor, true);
    await Promise.resolve();
    await Promise.resolve();
    await (provider as any).renderDecorations(editor, true);
    editor.setDecorations.resetHistory();

    staleBuild.reject(new Error("stale build failed"));
    await staleRender;

    assert.ok(
      editor.setDecorations.notCalled,
      "older failure must not erase the newer document's decorations"
    );
  });

  test("slow direct render cannot repaint after blame is disabled", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = {
      workspaceRoot: "/a",
      getResourceFromFile: () => undefined,
      isInsideUnversionedOrIgnored: () => undefined
    };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const editor = editorFor(uri);
    (window as any).visibleTextEditors = [editor];
    sandbox.stub(window, "activeTextEditor").value(editor);
    const data = deferred<any[]>();
    let enabled = true;
    sandbox.stub(provider as any, "shouldDecorate").callsFake(() => enabled);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox.stub(provider as any, "getBlameData").returns(data.promise);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);
    sandbox.stub(provider as any, "createAllDecorations").resolves({
      gutter: [{ range: {} }],
      icon: [],
      inline: []
    });
    sandbox.stub(provider as any, "applyIconDecorations");
    sandbox.stub(provider as any, "ensureAddRevision").resolves(false);

    const render = (provider as any).renderDecorations(editor, true);
    await Promise.resolve();
    enabled = false;
    provider.clearDecorations(editor);
    editor.setDecorations.resetHistory();
    data.resolve([{ lineNumber: 1, revision: "1", author: "old" }]);
    await render;

    assert.ok(
      editor.setDecorations
        .getCalls()
        .every(
          (call: sinon.SinonSpyCall) =>
            Array.isArray(call.args[1]) && call.args[1].length === 0
        ),
      "disabled file must not receive a late non-empty apply"
    );
  });

  test("add-revision completion repaints its visible URI after focus moves", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = {
      workspaceRoot: "/a",
      getResourceFromFile: () => undefined,
      isInsideUnversionedOrIgnored: () => undefined
    };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const editor = editorFor(uri);
    const other = editorFor(Uri.file("/a/other.ts"));
    let active = editor;
    sandbox.stub(window, "activeTextEditor").get(() => active);
    (window as any).visibleTextEditors = [editor, other];
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    sandbox
      .stub(provider as any, "getBlameData")
      .resolves([{ lineNumber: 1, revision: "1", author: "dev" }]);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);
    sandbox.stub(provider as any, "createAllDecorations").resolves({
      gutter: [],
      icon: [],
      inline: []
    });
    sandbox.stub(provider as any, "applyIconDecorations");
    const marker = deferred<boolean>();
    sandbox.stub(provider as any, "ensureAddRevision").returns(marker.promise);
    sandbox.stub(provider as any, "prefetchPeekData").resolves(undefined);
    const bulk = sandbox
      .stub(provider as any, "renderVisibleEditors")
      .resolves(undefined);

    await (provider as any).renderDecorations(editor);
    active = other;
    marker.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(
      bulk.calledOnce &&
        bulk.firstCall.args[0].includes(editor) &&
        !bulk.firstCall.args[0].includes(other),
      "marker completion must repaint only matching visible splits"
    );
  });

  test("concurrent add-revision lookup cannot overwrite success with failure", async () => {
    const uri = Uri.file("/a/file.ts");
    const success = deferred<Array<{ revision: string }>>();
    const lateFailure = deferred<Array<{ revision: string }>>();
    const log = sandbox.stub();
    log.onFirstCall().returns(success.promise);
    log.onSecondCall().returns(lateFailure.promise);
    const repo = { workspaceRoot: "/a", repository: { log } };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);

    const first = (provider as any).ensureAddRevision(uri);
    const joiner = (provider as any).ensureAddRevision(uri);
    success.resolve([{ revision: "10" }]);
    assert.strictEqual(await first, true);
    if (log.calledTwice) {
      lateFailure.reject(new Error("late failure"));
    }
    assert.strictEqual(await joiner, false);

    assert.ok(log.calledOnce, "same owner generation shares one lookup");
    assert.strictEqual(
      (provider as any).addRevisionCache.get(uri.toString()),
      "10"
    );
  });

  test("cursor fetch cannot repaint inline after inline mode is disabled", async () => {
    const uri = Uri.file("/a/file.ts");
    const repo = { workspaceRoot: "/a" };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const editor = editorFor(uri);
    sandbox.stub(window, "activeTextEditor").value(editor);
    (window as any).visibleTextEditors = [editor];
    let inlineEnabled = true;
    sandbox
      .stub(blameConfiguration, "isInlineEnabled")
      .callsFake(() => inlineEnabled);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    const data = deferred<any[]>();
    sandbox.stub(provider as any, "getBlameData").returns(data.promise);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);

    const update = (provider as any).updateInlineDecorationsForCursor(editor);
    inlineEnabled = false;
    data.resolve([{ lineNumber: 1, revision: "1", author: "dev" }]);
    await update;

    assert.ok(
      editor.setDecorations
        .getCalls()
        .every(
          (call: sinon.SinonSpyCall) =>
            Array.isArray(call.args[1]) && call.args[1].length === 0
        ),
      "disabled inline mode must not receive a late non-empty apply"
    );
  });
});
