import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { commands, Uri, window, workspace } from "vscode";
import { Status } from "../../../common/types";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Repository } from "../../../repository";

function setupRepositoryMock(
  mockRepository: sinon.SinonStubbedInstance<Repository>
): void {
  (mockRepository as any).statusReady = Promise.resolve();
  (mockRepository as any).repository = {
    workspaceRoot: "/test",
    root: "/test",
    info: { url: "http://svn.example/repo" },
    show: async () => ""
  };
}

function createEditor(uri: Uri, lineCount = 2, version = 1): any {
  return {
    document: {
      uri,
      lineCount,
      version,
      fsPath: uri.fsPath,
      fileName: uri.fsPath,
      getText: () => "a\nb",
      lineAt: () => ({ range: { end: { character: 5 } } })
    },
    selection: { active: { line: 0 } },
    visibleRanges: [{ start: { line: 0 }, end: { line: lineCount } }],
    setDecorations: sinon.stub()
  };
}

suite("BlameProvider - Fail Cluster", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    setupRepositoryMock(mockRepository);
    provider = new BlameProvider(scmFor(mockRepository as any));
  });

  teardown(() => {
    if (provider) {
      provider.dispose();
    }
    sandbox.restore();
  });

  test("activate registers once and ignores second activate", () => {
    const uri = Uri.file("/test/file.ts");
    const editor = createEditor(uri);
    sandbox.stub(window, "activeTextEditor").value(editor);

    const activeChangeSpy = sandbox.spy(
      provider as any,
      "onActiveEditorChange"
    );
    const beforeWindow = (window.onDidChangeActiveTextEditor as any).mock.calls
      .length;
    const beforeWorkspace = (workspace.onDidChangeTextDocument as any).mock
      .calls.length;

    provider.activate();
    provider.activate();

    const afterWindow = (window.onDidChangeActiveTextEditor as any).mock.calls
      .length;
    const afterWorkspace = (workspace.onDidChangeTextDocument as any).mock.calls
      .length;

    assert.strictEqual(afterWindow - beforeWindow, 1);
    assert.strictEqual(afterWorkspace - beforeWorkspace, 1);
    assert.strictEqual(activeChangeSpy.callCount, 1);
  });

  test("onConfigurationChange clears old decorations, disposes old types, and refreshes", async () => {
    const createdTypes: Array<{ dispose: sinon.SinonStub }> = [];
    sandbox.stub(window, "createTextEditorDecorationType").callsFake(() => {
      const type = { dispose: sandbox.stub() };
      createdTypes.push(type);
      return type as any;
    });

    provider.dispose();
    provider = new BlameProvider(scmFor(mockRepository as any));

    const editor = createEditor(Uri.file("/test/file.ts"));
    sandbox.stub(window, "activeTextEditor").value(editor);

    const oldIconType = { dispose: sandbox.stub() };
    (provider as any).iconTypes.set("#abc123", oldIconType as any);
    (provider as any).revisionColors.set("123", "#000000");
    (provider as any).svgCache.set("#000000", Uri.parse("data:text/plain,a"));
    (provider as any).compiledGutterTemplate = {
      template: "x",
      fn: (_ctx: any) => "x"
    };
    (provider as any).compiledInlineTemplate = {
      template: "y",
      fn: (_ctx: any) => "y"
    };

    const renderStub = sandbox
      .stub(provider as any, "renderDecorations")
      .resolves(undefined);

    await (provider as any).onConfigurationChange({} as any);

    assert.strictEqual(createdTypes.length, 6);
    assert.ok(createdTypes[0]!.dispose.calledOnce);
    assert.ok(createdTypes[1]!.dispose.calledOnce);
    assert.ok(createdTypes[2]!.dispose.calledOnce);
    assert.ok(oldIconType.dispose.calledOnce);
    assert.strictEqual((provider as any).revisionColors.size, 0);
    assert.strictEqual((provider as any).svgCache.size, 0);
    assert.strictEqual((provider as any).compiledGutterTemplate, undefined);
    assert.strictEqual((provider as any).compiledInlineTemplate, undefined);
    assert.ok(editor.setDecorations.callCount >= 4);
    assert.ok(renderStub.calledOnceWith(editor));
  });

  test("getBlameData uses cache when editor version matches", async () => {
    const uri = Uri.file("/test/cached.ts");
    const cachedData = [
      {
        lineNumber: 1,
        revision: "100",
        author: "dev",
        date: "2026-01-01T00:00:00Z"
      }
    ];

    (provider as any).blameCache.set(uri.toString(), {
      data: cachedData,
      version: 7
    });
    const editor = createEditor(uri, 1, 7);
    sandbox.stub(window, "activeTextEditor").value(editor);

    const result = await (provider as any).getBlameData(uri, editor);

    assert.deepStrictEqual(result, cachedData);
    assert.ok(mockRepository.getInfo.notCalled);
    assert.ok(mockRepository.blame.notCalled);
  });

  test("getBlameData auth failure prompts auth command", async () => {
    const uri = Uri.file("/test/auth.ts");

    mockRepository.getResourceFromFile.returns(undefined as any);
    mockRepository.getInfo.resolves({} as any);
    mockRepository.blame.rejects(
      new Error("svn: E170001: Authentication failed")
    );

    const warningStub = sandbox
      .stub(window, "showWarningMessage")
      .resolves("Authenticate" as any);
    const errorStub = sandbox.stub(window, "showErrorMessage");
    const executeStub = sandbox
      .stub(commands, "executeCommand")
      .resolves(undefined);

    const result = await (provider as any).getBlameData(uri, createEditor(uri));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.strictEqual(result, undefined);
    assert.ok(warningStub.calledOnce);
    assert.ok(errorStub.notCalled);
    assert.ok(executeStub.calledOnce);
    assert.strictEqual(executeStub.firstCall.args[0], "sven.promptAuth");
    assert.strictEqual(
      executeStub.firstCall.args[3],
      "http://svn.example/repo"
    );
  });

  test("getBlameData network failure shows connection error", async () => {
    const uri = Uri.file("/test/network.ts");

    mockRepository.getResourceFromFile.returns(undefined as any);
    mockRepository.getInfo.resolves({} as any);
    mockRepository.blame.rejects(new Error("svn: E170013: Unable to connect"));

    const warningStub = sandbox.stub(window, "showWarningMessage");
    const errorStub = sandbox.stub(window, "showErrorMessage");

    const result = await (provider as any).getBlameData(uri, createEditor(uri));

    assert.strictEqual(result, undefined);
    assert.ok(warningStub.notCalled);
    assert.ok(errorStub.calledOnce);
  });

  test("getBlameData suppresses untracked file errors", async () => {
    const uri = Uri.file("/test/untracked.ts");

    mockRepository.getResourceFromFile.returns({
      type: Status.MODIFIED,
      resourceUri: uri
    } as any);
    mockRepository.getInfo.resolves({} as any);
    mockRepository.blame.rejects({ stderr: "svn: warning W155010: not found" });

    const warningStub = sandbox.stub(window, "showWarningMessage");
    const errorStub = sandbox.stub(window, "showErrorMessage");

    const result = await (provider as any).getBlameData(uri, createEditor(uri));

    assert.strictEqual(result, undefined);
    assert.ok(warningStub.notCalled);
    assert.ok(errorStub.notCalled);
  });

  test("getRevisionColor covers older-revision and missing-index branches", () => {
    sandbox.stub(provider as any, "getThemeAwareLightness").returns(60);
    const range = { min: 5, max: 10, uniqueRevisions: [10, 9, 8, 7, 6, 5] };

    const olderColor = (provider as any).getRevisionColor("5", range);
    const olderExpected = (provider as any).hslToHex(200, 45, 60);
    assert.strictEqual(olderColor, olderExpected);

    const missingColor = (provider as any).getRevisionColor("999", range);
    const missingExpected = (provider as any).hslToHex(240, 45, 60);
    assert.strictEqual(missingColor, missingExpected);
  });

  test("updateDecorations clears when editor outside repository", async () => {
    const editor = createEditor(Uri.file("/outside/file.ts"));
    const clearStub = sandbox.stub(provider as any, "clearDecorations");

    await provider.updateDecorations(editor);

    assert.ok(clearStub.calledOnceWith(editor));
  });

  test("updateDecorations warns on large files", async () => {
    const editor = createEditor(Uri.file("/test/large.ts"), 5000, 1);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    sandbox.stub(provider as any, "getParentFolderStatus").returns(undefined);
    mockRepository.getResourceFromFile.returns(undefined as any);
    sandbox.stub(blameConfiguration, "isFileTooLarge").returns(true);
    sandbox.stub(blameConfiguration, "shouldWarnLargeFile").returns(true);
    const warningStub = sandbox.stub(window, "showWarningMessage");

    await provider.updateDecorations(editor);

    assert.ok(warningStub.calledOnce);
  });

  test("updateDecorations skips csv files exceeding csvLineLimit (no blame fetch, no svn cat)", async () => {
    const editor = createEditor(Uri.file("/test/big.csv"), 5000, 1);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    sandbox.stub(provider as any, "getParentFolderStatus").returns(undefined);
    mockRepository.getResourceFromFile.returns(undefined as any);
    sandbox.stub(blameConfiguration, "isCsvLike").returns(true);
    sandbox.stub(blameConfiguration, "getCsvLineLimit").returns(500);
    const fetchStub = sandbox.stub(provider as any, "getBlameData");
    const warningStub = sandbox.stub(window, "showWarningMessage");

    await provider.updateDecorations(editor);

    assert.ok(fetchStub.notCalled, "should not fetch blame data for big CSV");
    assert.ok(
      warningStub.calledOnce,
      "should warn about CSV size (configurable)"
    );
  });

  test("updateDecorations catches unexpected failures and clears", async () => {
    const editor = createEditor(Uri.file("/test/crash.ts"), 10, 1);
    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    sandbox.stub(provider as any, "getParentFolderStatus").returns(undefined);
    mockRepository.getResourceFromFile.returns(undefined as any);
    sandbox.stub(blameConfiguration, "isFileTooLarge").returns(false);
    sandbox.stub(provider as any, "getBlameData").rejects(new Error("boom"));
    const clearStub = sandbox.stub(provider as any, "clearDecorations");

    await provider.updateDecorations(editor);

    assert.ok(clearStub.calledOnceWith(editor));
  });

  test("prefetchMessagesProgressively reuses in-flight, skips empty, clears when disabled", async () => {
    const uri = Uri.file("/test/prefetch.ts");
    const editor = createEditor(uri);
    let release!: () => void;
    const prefetchStub = sandbox
      .stub(provider as any, "prefetchMessages")
      .returns(new Promise<void>(resolve => (release = resolve)));
    const data = [
      { lineNumber: 1, revision: "1", author: "dev", date: "2026-01-01" }
    ];
    const first = (provider as any).prefetchMessagesProgressively(
      uri,
      data,
      editor
    );
    const reused = (provider as any).prefetchMessagesProgressively(
      uri,
      data,
      editor
    );
    assert.ok(prefetchStub.calledOnce);
    release();
    await Promise.all([first, reused]);

    (provider as any).inFlightMessageFetches.clear();
    prefetchStub.reset();
    prefetchStub.resolves(undefined);
    const skipped = await (provider as any).prefetchMessagesProgressively(
      uri,
      [],
      editor,
      []
    );
    assert.strictEqual(skipped, undefined);

    sandbox.stub(blameStateManager, "isBlameEnabled").returns(false);
    sandbox.stub(window, "activeTextEditor").value(editor);
    const clearStub = sandbox.stub(provider as any, "clearDecorations");

    await (provider as any).prefetchMessagesProgressively(
      uri,
      [{ lineNumber: 1, revision: "1", author: "dev", date: "2026-01-01" }],
      editor
    );

    assert.ok(clearStub.calledOnceWith(editor));
  });

  test("document/cursor handlers cover debounce and branch paths", async () => {
    const clock = sandbox.useFakeTimers();
    const uri = Uri.file("/test/handlers.ts");
    const editor = createEditor(uri, 3, 2);
    sandbox.stub(window, "activeTextEditor").value(editor);

    const clearStub = sandbox.stub(provider as any, "clearDecorations");
    const cacheStub = sandbox.stub(provider as any, "clearCache");
    const updateStub = sandbox
      .stub(provider as any, "updateDecorations")
      .resolves(undefined);
    const renderStub = sandbox
      .stub(provider as any, "renderDecorations")
      .resolves(undefined);
    const inlineStub = sandbox
      .stub(provider as any, "updateInlineDecorationsForCursor")
      .resolves(undefined);

    (provider as any).onDocumentChange({ document: { uri } });
    clock.tick(500);
    assert.ok(clearStub.calledOnceWith(editor));

    await (provider as any).onDocumentSave({ uri });
    assert.ok(cacheStub.calledWith(uri));
    assert.ok(renderStub.calledOnceWith(editor));

    (provider as any).onDocumentClose({ uri });
    assert.ok(cacheStub.calledTwice);

    await (provider as any).onActiveEditorChange(undefined);
    assert.ok(updateStub.notCalled);

    const currentLineOnlyStub = sandbox
      .stub(blameConfiguration, "isInlineCurrentLineOnly")
      .returns(true);
    (provider as any).cursorLines.set(editor, 0);
    (provider as any).onCursorPositionChange({ textEditor: editor });
    clock.tick(151);
    await Promise.resolve();
    assert.ok(inlineStub.notCalled);

    editor.selection = { active: { line: 1 } };
    (provider as any).onCursorPositionChange({ textEditor: editor });
    clock.tick(151);
    await Promise.resolve();
    assert.ok(inlineStub.calledOnce);
    assert.strictEqual((provider as any).cursorLines.get(editor), 1);
    assert.ok(currentLineOnlyStub.called);
  });

  test("getBlameData fast-returns for unversioned files without svn calls", async () => {
    const uri = Uri.file("/test/branches.ts");

    mockRepository.getResourceFromFile.returns({
      type: Status.UNVERSIONED,
      resourceUri: uri
    } as any);
    const first = await (provider as any).getBlameData(uri, createEditor(uri));
    assert.strictEqual(first, undefined);
    assert.ok(mockRepository.getInfo.notCalled);
    assert.ok(mockRepository.blame.notCalled);
  });

  test("line mapping and decoration helpers cover remaining branch paths", async () => {
    const uri = Uri.file("/test/mapping.ts");
    const editor = createEditor(uri, 2, 3);

    const cachedMapping = { mapBaseToWorking: new Map([[1, 1]]) };
    (provider as any).lineMappingCache.set(uri.toString(), {
      mapping: cachedMapping,
      version: 3
    });
    const fromCache = await (provider as any).getLineMapping(uri, editor);
    assert.strictEqual(fromCache, cachedMapping);

    (provider as any).lineMappingCache.clear();
    mockRepository.getResourceFromFile.returns({
      type: Status.MODIFIED,
      resourceUri: uri
    } as any);
    (mockRepository as any).repository.show = sandbox
      .stub()
      .rejects(new Error("show failed"));
    const mappingError = await (provider as any).getLineMapping(uri, editor);
    assert.strictEqual(mappingError, undefined);

    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(false);
    sandbox.stub(blameConfiguration, "getInlineOpacity").returns(0.5);
    sandbox
      .stub(blameConfiguration, "getGutterTemplate")
      .returns("${author} ${revision}");
    sandbox.stub(blameConfiguration, "getDateFormat").returns("relative");
    sandbox.stub(provider as any, "prefetchMessages").resolves(undefined);
    sandbox.stub(provider as any, "getCommitMessage").resolves("msg");

    const decorations = await (provider as any).createAllDecorations(
      [
        { lineNumber: 1, revision: "1", author: "a", date: "2026-01-01" },
        { lineNumber: 99, revision: "2", author: "b", date: "2026-01-01" },
        { lineNumber: 2, revision: "", author: "", date: "2026-01-01" }
      ],
      editor
    );

    assert.strictEqual(decorations.gutter.length, 2);
    assert.strictEqual(decorations.inline.length, 1);
  });

  test("misc helper branches: scheme, ranges, gradient, hue, icon cache, truncate", () => {
    const nonFileEditor = createEditor(Uri.parse("untitled:test"));
    assert.strictEqual((provider as any).shouldDecorate(nonFileEditor), false);

    assert.deepStrictEqual((provider as any).getRevisionRange([]), {
      min: 0,
      max: 0,
      uniqueRevisions: []
    });

    sandbox.stub(provider as any, "getThemeAwareLightness").returns(60);
    const gradientRange = {
      min: 4,
      max: 10,
      uniqueRevisions: [10, 9, 8, 7, 6, 5, 4]
    };
    const gradientColor = (provider as any).getRevisionColor(
      "4",
      gradientRange
    );
    assert.ok(/^#[0-9a-f]{6}$/i.test(gradientColor));

    const hueColor = (provider as any).hslToHex(330, 45, 60);
    assert.ok(/^#[0-9a-f]{6}$/i.test(hueColor));

    const iconType = { dispose: sandbox.stub() };
    (provider as any).iconTypes.set("#112233", iconType);
    assert.strictEqual(
      (provider as any).getIconDecorationType("#112233"),
      iconType
    );

    sandbox.stub(blameConfiguration, "getInlineMaxLength").returns(10);
    const truncated = (provider as any).truncateMessage(
      "superlongwordwithoutspaces"
    );
    assert.strictEqual(truncated.length, 10);
    assert.ok(truncated.endsWith("..."));
  });

  test("updateInlineDecorationsForCursor handles early exits and skip branches", async () => {
    const editor = createEditor(Uri.file("/test/cursor.ts"), 2, 1);
    (window as any).visibleTextEditors = [editor];

    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(false);
    await (provider as any).updateInlineDecorationsForCursor(editor);

    (blameConfiguration.isInlineEnabled as any).restore?.();
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    await (provider as any).updateInlineDecorationsForCursor(
      createEditor(Uri.file("/outside/cursor.ts"), 2, 1)
    );

    sandbox.stub(provider as any, "shouldDecorate").returns(true);
    sandbox.stub(provider as any, "getBlameData").resolves([
      { lineNumber: 3, revision: "1", author: "a", date: "2026-01-01" },
      { lineNumber: 1, revision: "", author: "", date: "2026-01-01" }
    ]);
    sandbox.stub(provider as any, "getLineMapping").resolves(undefined);

    await (provider as any).updateInlineDecorationsForCursor(editor);
    assert.ok(editor.setDecorations.called);
  });
});
