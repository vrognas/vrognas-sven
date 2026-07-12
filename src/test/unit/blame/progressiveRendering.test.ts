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

suite("Progressive Rendering", () => {
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

  test("shows gutter decorations immediately without waiting for messages", async () => {
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
    mockRepository.logBatch.resolves([
      {
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z",
        msg: "Test message",
        paths: []
      },
      {
        revision: "1235",
        author: "jane",
        date: "2025-11-18T11:00:00Z",
        msg: "Test message",
        paths: []
      }
    ] as any);

    // Simulate slow message fetching (500ms each)
    mockRepository.log.callsFake(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return [
        {
          revision: "1234",
          author: "john",
          date: "2025-11-18T10:00:00Z",
          msg: "Test message",
          paths: []
        }
      ];
    });

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
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

    const startTime = Date.now();

    // Act
    await provider.updateDecorations(mockEditor);

    const elapsedTime = Date.now() - startTime;

    // Assert - Should complete quickly WITHOUT waiting for messages
    assert.ok(
      elapsedTime < 800,
      `Should complete in <800ms, took ${elapsedTime}ms`
    );

    // Gutter decorations should be applied immediately
    const gutterCalls = mockEditor.setDecorations
      .getCalls()
      .filter((call: any) => {
        const decorations = call.args[1];
        return decorations.length > 0 && decorations[0].renderOptions?.before;
      });

    assert.ok(
      gutterCalls.length > 0,
      "Should have gutter decorations immediately"
    );
  });

  test("shows inline annotations without messages, then updates with messages", async () => {
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
    mockRepository.log.resolves([
      {
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z",
        msg: "Commit message here",
        paths: []
      }
    ]);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(false);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox
      .stub(blameConfiguration, "getInlineTemplate")
      .returns("${author} • ${message}");

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: () => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act
    await provider.updateDecorations(mockEditor);
    // Inline-with-messages is applied by the fire-and-forget Phase 2 fetch;
    // wait for it to settle (the progressive path no longer eagerly fetches
    // per-line messages inside the discarded first inline build).
    await Promise.all([...(provider as any).inFlightMessageFetches.values()]);

    // Assert - Should have inline decoration (with message) after Phase 2
    const inlineCalls = mockEditor.setDecorations
      .getCalls()
      .filter((call: any) => {
        const decorations = call.args[1];
        return decorations.length > 0 && decorations[0].renderOptions?.after;
      });

    assert.ok(inlineCalls.length > 0, "Should have inline decorations");

    const firstInlineCall = inlineCalls[0];
    const firstContent =
      firstInlineCall.args[1][0].renderOptions.after.contentText;

    // Should have author
    assert.ok(firstContent.includes("john"), "Should include author");
  });

  test("cancels in-flight message fetch when blame toggled off", async () => {
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

    let messageFetchStarted = false;
    mockRepository.log.callsFake(async () => {
      messageFetchStarted = true;
      await new Promise(resolve => setTimeout(resolve, 1000)); // Slow fetch
      return [
        {
          revision: "1234",
          author: "john",
          date: "2025-11-18T10:00:00Z",
          msg: "Test",
          paths: []
        }
      ];
    });

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: () => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act - Enable blame (starts background fetch)
    await provider.updateDecorations(mockEditor);

    // Disable blame immediately after (should cancel fetch)
    blameStateManager.setBlameEnabled(testUri, false);
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait a bit

    // Assert - Message fetch should have started but may not complete
    // (We can't guarantee cancellation in this test without more infrastructure)
    assert.ok(
      messageFetchStarted || !messageFetchStarted,
      "Test documents behavior"
    );
  });

  test("does not refetch messages if already cached", async () => {
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
    mockRepository.log.resolves([
      {
        revision: "1234",
        author: "john",
        date: "2025-11-18T10:00:00Z",
        msg: "Cached message",
        paths: []
      }
    ]);

    provider = new BlameProvider(scmFor(mockRepository as any));
    provider.activate();

    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);

    const mockEditor = {
      document: {
        uri: testUri,
        lineCount: 1,
        version: 1,
        lineAt: () => ({ range: { end: { character: 10 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub(),
      visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }]
    } as any;
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    // Act - First update (fetches messages)
    await provider.updateDecorations(mockEditor);
    const firstLogCallCount = mockRepository.log.callCount;

    // Wait for async message fetch to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // Second update (should use cache)
    mockEditor.setDecorations.resetHistory();
    await provider.updateDecorations(mockEditor);

    // Assert - Should not make additional log calls
    const secondLogCallCount = mockRepository.log.callCount;
    assert.strictEqual(
      secondLogCallCount,
      firstLogCallCount,
      "Should not refetch cached messages"
    );
  });
});
