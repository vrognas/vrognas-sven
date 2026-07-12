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

suite("Inline Blame Cursor Tracking", () => {
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

  test("shows inline only on current line when currentLineOnly enabled", async () => {
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
        author: "bob",
        date: "2025-11-18T12:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 3,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 1 } }, // Cursor on line 2 (0-indexed)
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 3 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act
    await provider.updateDecorations(mockEditor);

    // Assert - Should only decorate current line (line 1 = 2nd line)
    const inlineCalls = mockEditor.setDecorations
      .getCalls()
      .filter((call: any) => {
        const decorations = call.args[1];
        return decorations.length > 0 && decorations[0].hoverMessage;
      });

    assert.ok(inlineCalls.length > 0, "Should have inline decorations");
    const decorations = inlineCalls[0].args[1];
    assert.strictEqual(
      decorations.length,
      1,
      "Should only decorate current line"
    );
    assert.strictEqual(
      decorations[0].range.startLine,
      1,
      "Should decorate line 1 (cursor line)"
    );
  });

  test("shows inline on all lines when currentLineOnly disabled", async () => {
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
        author: "bob",
        date: "2025-11-18T12:00:00Z"
      }
    ];

    mockRepository.blame.resolves(blameData);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(false);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 3,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 1 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 3 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act
    await provider.updateDecorations(mockEditor);

    // Assert - Should decorate all lines
    const inlineCalls = mockEditor.setDecorations
      .getCalls()
      .filter((call: any) => {
        const decorations = call.args[1];
        return decorations.length > 0 && decorations[0].hoverMessage;
      });

    assert.ok(inlineCalls.length > 0, "Should have inline decorations");
    const decorations = inlineCalls[0].args[1];
    assert.strictEqual(decorations.length, 3, "Should decorate all 3 lines");
  });

  test("updates decoration when cursor moves", async () => {
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
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 2,
        version: 1,
        lineAt: (_index: number) => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } }, // Start at line 1
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 2 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act - Initial decoration at line 0
    await provider.updateDecorations(mockEditor);
    const firstCallCount = mockEditor.setDecorations.callCount;

    // Move cursor to line 1
    mockEditor.selection.active.line = 1;
    await provider.updateDecorations(mockEditor);

    // Assert - Should have called setDecorations again
    assert.ok(
      mockEditor.setDecorations.callCount > firstCallCount,
      "Should update decorations after cursor move"
    );

    // Find the last inline decoration call
    const calls = mockEditor.setDecorations.getCalls();
    const lastInlineCall = calls.reverse().find((call: any) => {
      const decorations = call.args[1];
      return decorations.length > 0 && decorations[0].hoverMessage;
    });

    assert.ok(
      lastInlineCall,
      "Should have inline decoration after cursor move"
    );
    const decorations = lastInlineCall.args[1];
    assert.strictEqual(
      decorations[0].range.startLine,
      1,
      "Should now decorate line 1"
    );
  });
});
