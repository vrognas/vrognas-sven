import { scmFor } from "./unit/blame/helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../blame/blameProvider";
import { blameConfiguration } from "../blame/blameConfiguration";
import { blameStateManager } from "../blame/blameStateManager";
import { Repository } from "../repository";
import { ISvnBlameLine, Status } from "../common/types";

function setupRepositoryMock(
  mockRepository: sinon.SinonStubbedInstance<Repository>
): void {
  (mockRepository as any).repository = {
    workspaceRoot: "/test",
    root: "/test",
    show: async () => ""
  };
}

suite("BlameProvider E2E Tests", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    setupRepositoryMock(mockRepository);
  });

  teardown(() => {
    if (provider) {
      provider.dispose();
    }
    sandbox.restore();
    delete (window as any).visibleTextEditors;
  });

  test("shows gutter decorations when blame enabled", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      },
      {
        lineNumber: 2,
        revision: "1235",
        author: "jane",
        date: "2025-11-18T11:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    // Create provider
    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    // Enable blame for file
    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    // Create mock editor
    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 2,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 2 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act
    await provider.updateDecorations(mockEditor);

    // Assert
    assert.ok(
      mockRepository.blame.calledOnce,
      "Repository.blame() should be called"
    );
    assert.ok(
      mockEditor.setDecorations.called,
      "Editor decorations should be set"
    );
    const nonEmptyCalls = mockEditor.setDecorations
      .getCalls()
      .filter(
        (call: any) => Array.isArray(call.args[1]) && call.args[1].length > 0
      );
    assert.ok(nonEmptyCalls.length > 0, "Should have non-empty decorations");
  });

  test("hides decorations when blame disabled", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    // Disable blame
    blameStateManager.setBlameEnabled(testUri, false);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 2,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 2 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act
    await provider.updateDecorations(mockEditor);

    // Assert
    assert.ok(
      mockRepository.blame.notCalled,
      "Repository.blame() should not be called"
    );
    assert.ok(mockEditor.setDecorations.called, "Should clear decorations");
  });

  test("updates decorations on file save", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const initialBlame: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      }
    ];
    const updatedBlame: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1236",
        author: "jane",
        date: "2025-11-18T12:00:00Z"
      }
    ];

    mockRepository.blame
      .onFirstCall()
      .resolves(initialBlame)
      .onSecondCall()
      .resolves(updatedBlame);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } }),
        getText: () => "modified content"
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act - Initial load
    await provider.updateDecorations(mockEditor);

    // Simulate file save by invalidating cache and updating
    provider.clearCache(testUri);
    await provider.updateDecorations(mockEditor);

    // Assert
    assert.strictEqual(
      mockRepository.blame.callCount,
      2,
      "Should fetch blame twice (initial + after save)"
    );
    assert.strictEqual(
      mockEditor.setDecorations.callCount >= 2,
      true,
      "Should update decorations at least twice"
    );
  });
});

suite("BlameProvider - Inline Decoration Optimization", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    setupRepositoryMock(mockRepository);
  });

  teardown(() => {
    if (provider) {
      provider.dispose();
    }
    sandbox.restore();
  });

  test("inline renders once when messages disabled", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);
    mockRepository.log.resolves([]);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(false); // Messages disabled
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(false);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      setDecorations: sandbox.stub(),
      selection: { active: { line: 0 } },
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act
    await provider.updateDecorations(mockEditor);
    await new Promise(resolve => setTimeout(resolve, 50)); // Wait for async operations

    // Assert
    const inlineDecorationCalls = mockEditor.setDecorations
      .getCalls()
      .filter(
        (call: any) => call.args[0] === (provider as any).decorationTypes.inline
      );

    assert.strictEqual(
      inlineDecorationCalls.length,
      1,
      "Inline should render once (immediately, no progressive update)"
    );
    assert.strictEqual(
      inlineDecorationCalls[0].args[1].length,
      1,
      "Should have 1 decoration"
    );
  });

  test("inline skips first render when messages will be fetched", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);
    mockRepository.logBatch.resolves([
      {
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z",
        msg: "Test commit",
        paths: []
      }
    ]);
    mockRepository.log.resolves([
      {
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z",
        msg: "Test commit",
        paths: []
      }
    ] as any);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true); // Messages enabled
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(false);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      setDecorations: sandbox.stub(),
      selection: { active: { line: 0 } },
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;

    // Act
    await provider.updateDecorations(mockEditor);

    // Assert
    const inlineDecorationCalls = mockEditor.setDecorations
      .getCalls()
      .filter(
        (call: any) => call.args[0] === (provider as any).decorationTypes.inline
      );

    assert.strictEqual(
      inlineDecorationCalls.length,
      0,
      "Inline should skip initial render when message fetch is enabled"
    );
  });

  test("inline not rendered when disabled", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(false); // Inline disabled
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      setDecorations: sandbox.stub(),
      selection: { active: { line: 0 } },
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;

    // Act
    await provider.updateDecorations(mockEditor);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert
    const inlineDecorationCalls = mockEditor.setDecorations
      .getCalls()
      .filter(
        (call: any) => call.args[0] === (provider as any).decorationTypes.inline
      );

    assert.strictEqual(
      inlineDecorationCalls.length,
      1,
      "Should call setDecorations once (to clear)"
    );
    assert.strictEqual(
      inlineDecorationCalls[0].args[1].length,
      0,
      "Should have 0 decorations (cleared)"
    );
  });
});

suite("BlameProvider Cursor Tracking Optimization", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    setupRepositoryMock(mockRepository);
  });

  teardown(() => {
    if (provider) {
      provider.dispose();
    }
    sandbox.restore();
    delete (window as any).visibleTextEditors;
  });

  test("cursor movement triggers lightweight inline-only update", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      },
      {
        lineNumber: 2,
        revision: "1235",
        author: "jane",
        date: "2025-11-18T11:00:00Z"
      },
      {
        lineNumber: 3,
        revision: "1236",
        author: "alice",
        date: "2025-11-18T12:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(false);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(false);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 3,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 3 } }]
    } as any;
    (window as any).visibleTextEditors = [mockEditor];

    // Act - Initial full update
    await provider.updateDecorations(mockEditor);
    const initialCallCount = mockEditor.setDecorations.callCount;

    // Simulate cursor movement to line 1
    mockEditor.selection = { active: { line: 1 } };
    await (provider as any).updateInlineDecorationsForCursor(mockEditor);

    // Assert - Should only update inline decorations (1 additional call, not 3)
    assert.strictEqual(
      mockEditor.setDecorations.callCount,
      initialCallCount + 1,
      "Should only call setDecorations once for inline (not gutter+icon+inline)"
    );

    // Verify it's the inline decoration type
    const lastCall = mockEditor.setDecorations.lastCall;
    const decorations = lastCall.args[1];
    assert.strictEqual(
      decorations.length,
      1,
      "Should only show current line decoration"
    );
    assert.ok(
      decorations[0].renderOptions?.after,
      "Should be inline decoration (after)"
    );
  });

  test("cursor update reuses cached blame data without re-fetch", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      },
      {
        lineNumber: 2,
        revision: "1235",
        author: "jane",
        date: "2025-11-18T11:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(false);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 2,
        version: 1,
        lineAt: () => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 2 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act - Initial load (fetches blame)
    await provider.updateDecorations(mockEditor);
    assert.strictEqual(
      mockRepository.blame.callCount,
      1,
      "Should fetch blame on initial load"
    );

    // Cursor movement (should NOT re-fetch)
    mockEditor.selection = { active: { line: 1 } };
    await (provider as any).updateInlineDecorationsForCursor(mockEditor);

    // Assert - No additional blame fetch
    assert.strictEqual(
      mockRepository.blame.callCount,
      1,
      "Should NOT re-fetch blame data on cursor movement (uses cache)"
    );
  });

  test("cursor update works without messages loaded", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      },
      {
        lineNumber: 2,
        revision: "1235",
        author: "jane",
        date: "2025-11-18T11:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true); // Messages enabled
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(false); // But logs disabled

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 2,
        lineAt: () => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 2 } }]
    } as any;
    (window as any).visibleTextEditors = [mockEditor];

    // Act - Initial load
    await provider.updateDecorations(mockEditor);

    // Cursor movement (messages not available)
    mockEditor.selection = { active: { line: 1 } };
    await (provider as any).updateInlineDecorationsForCursor(mockEditor);

    // Assert - Should still show inline decoration (without message)
    const lastCall = mockEditor.setDecorations.lastCall;
    const decorations = lastCall.args[1];
    assert.strictEqual(
      decorations.length,
      1,
      "Should show decoration even without message"
    );
    const contentText = decorations[0].renderOptions?.after?.contentText || "";
    assert.ok(contentText.includes("jane"), "Should show author");
    assert.ok(contentText.includes("1235"), "Should show revision");
  });

  test("cursor update respects per-file blame state", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      },
      {
        lineNumber: 2,
        revision: "1235",
        author: "jane",
        date: "2025-11-18T11:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    // Enable blame initially
    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(false);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(false);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 2,
        lineAt: () => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 2 } }]
    } as any;

    // Act 1 - Initial load with blame enabled
    await provider.updateDecorations(mockEditor);
    const initialCallCount = mockEditor.setDecorations.callCount;

    // Disable blame for file
    blameStateManager.setBlameEnabled(testUri, false);

    // Simulate cursor movement
    mockEditor.selection = { active: { line: 1 } };
    await (provider as any).updateInlineDecorationsForCursor(mockEditor);

    // Assert - Should clear decorations (not render new ones)
    assert.strictEqual(
      mockEditor.setDecorations.callCount,
      initialCallCount + 1,
      "Should call setDecorations to clear"
    );

    const lastCall = mockEditor.setDecorations.lastCall;
    const decorations = lastCall.args[1];
    assert.strictEqual(
      decorations.length,
      0,
      "Should have 0 decorations when blame disabled for file"
    );
  });
});

suite("BlameProvider - Skip Unblameable Files", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    setupRepositoryMock(mockRepository);
  });

  teardown(() => {
    if (provider) {
      provider.dispose();
    }
    sandbox.restore();
  });

  test("skips blame for ADDED files (never committed)", async () => {
    // Arrange - File is scheduled for addition but never committed
    const testUri = Uri.file("/test/new-file.txt");

    // Mock resource with ADDED status
    mockRepository.getResourceFromFile.returns({
      type: Status.ADDED,
      resourceUri: testUri
    } as any);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 10,
        version: 1,
        fileName: "/test/new-file.txt",
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 10 } }]
    } as any;

    // Act
    await provider.updateDecorations(mockEditor);

    // Assert - blame() should NOT be called for ADDED files
    assert.ok(
      mockRepository.blame.notCalled,
      "Should NOT call blame for ADDED files"
    );
    assert.ok(mockEditor.setDecorations.called, "Should clear decorations");
  });

  test("skips blame for UNVERSIONED files", async () => {
    const testUri = Uri.file("/test/untracked.txt");

    mockRepository.getResourceFromFile.returns({
      type: Status.UNVERSIONED,
      resourceUri: testUri
    } as any);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 5,
        version: 1,
        fileName: "/test/untracked.txt",
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 5 } }]
    } as any;

    await provider.updateDecorations(mockEditor);

    assert.ok(
      mockRepository.blame.notCalled,
      "Should NOT call blame for UNVERSIONED files"
    );
  });

  test("fetches blame for MODIFIED files (committed before)", async () => {
    const testUri = Uri.file("/test/modified.txt");
    const blameData: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "100",
        author: "dev",
        date: "2025-11-27T10:00:00Z"
      }
    ];

    mockRepository.getResourceFromFile.returns({
      type: Status.MODIFIED,
      resourceUri: testUri
    } as any);
    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        fileName: "/test/modified.txt",
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } }),
        getText: () => "modified content"
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;

    await provider.updateDecorations(mockEditor);

    assert.ok(
      mockRepository.blame.calledOnce,
      "Should call blame for MODIFIED files"
    );
  });
});
