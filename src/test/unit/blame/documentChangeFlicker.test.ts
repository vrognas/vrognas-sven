import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

function setupRepositoryMock(
  mockRepository: sinon.SinonStubbedInstance<Repository>
): void {
  (mockRepository as any).repository = {
    workspaceRoot: "/test",
    root: "/test"
  };
}

suite("BlameProvider - Document Change Flicker Fix", () => {
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

  test("clearCache invalidates cache for next fetch", async () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");
    const cachedBlame: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z"
      }
    ];
    const freshBlame: ISvnBlameLine[] = [
      {
        lineNumber: 1,
        revision: "1236",
        author: "jane",
        date: "2025-11-18T12:00:00Z"
      }
    ];

    mockRepository.blame
      .onFirstCall()
      .resolves(cachedBlame)
      .onSecondCall()
      .resolves(freshBlame);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act - First call should fetch and cache
    await provider.updateDecorations(mockEditor);
    assert.strictEqual(
      mockRepository.blame.callCount,
      1,
      "First call should fetch blame"
    );

    // Second call should use cache
    await provider.updateDecorations(mockEditor);
    assert.strictEqual(
      mockRepository.blame.callCount,
      1,
      "Second call should use cache"
    );

    // Invalidate cache (simulates onDocumentChange behavior)
    provider.clearCache(testUri);

    // Third call should fetch fresh data
    await provider.updateDecorations(mockEditor);

    // Assert
    assert.strictEqual(
      mockRepository.blame.callCount,
      2,
      "After clearCache, should fetch fresh blame"
    );
  });

  test("clearDecorations removes all decorations", () => {
    // Arrange
    const testUri = Uri.file("/test/file.txt");

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;

    // Act
    provider.clearDecorations(mockEditor);

    // Assert
    assert.ok(mockEditor.setDecorations.called, "Should call setDecorations");
    const calls = mockEditor.setDecorations.getCalls();

    // Should clear at least gutter, icon, and inline decorations
    assert.ok(calls.length >= 3, "Should clear at least 3 decoration types");

    // Each call should pass empty array (clears decorations)
    calls.forEach((call: any) => {
      const decorations = call.args[1];
      assert.strictEqual(
        decorations.length,
        0,
        "Each decoration type should be cleared"
      );
    });
  });

  test("document change: cache cleared but decorations NOT cleared", async () => {
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
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act - Initial render
    await provider.updateDecorations(mockEditor);
    const initialCallCount = mockEditor.setDecorations.callCount;
    assert.ok(initialCallCount > 0, "Should set decorations initially");

    // Simulate document change (cache invalidated, decorations stay)
    provider.clearCache(testUri);

    // Assert - No additional setDecorations calls (decorations not cleared)
    assert.strictEqual(
      mockEditor.setDecorations.callCount,
      initialCallCount,
      "clearCache should NOT call setDecorations (no flicker)"
    );

    // Verify cache actually cleared by checking next fetch
    await provider.updateDecorations(mockEditor);
    assert.strictEqual(
      mockRepository.blame.callCount,
      2,
      "After clearCache, next update should fetch fresh data"
    );
  });
});
