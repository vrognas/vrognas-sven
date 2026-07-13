import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameStatusBar } from "../../../blame/blameStatusBar";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Repository } from "../../../repository";
import { SourceControlManager } from "../../../source_control_manager";
import { ISvnBlameLine } from "../../../common/types";

const BLAME_DATA: ISvnBlameLine[] = [
  {
    lineNumber: 1,
    revision: "1234",
    author: "john",
    date: "2025-11-18T10:00:00Z"
  }
];

function makeMockRepo(sandbox: sinon.SinonSandbox) {
  return {
    blame: sandbox.stub().resolves(BLAME_DATA),
    root: "/test",
    workspaceRoot: "/test",
    statusReady: Promise.resolve(),
    getResourceFromFile: sandbox.stub().returns(undefined),
    isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined)
  };
}

function makeMockEditor(uri: Uri, lineCount: number) {
  return {
    document: {
      uri,
      lineCount,
      version: 1,
      lineAt: (_i: number) => ({ range: { end: { character: 10 } } })
    },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub(),
    visibleRanges: [{ start: { line: 0 }, end: { line: lineCount } }]
  } as any;
}

suite("Blame size gates", () => {
  let sandbox: sinon.SinonSandbox;
  let statusBar: BlameStatusBar;
  let provider: BlameProvider;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isStatusBarEnabled").returns(true);
  });

  teardown(() => {
    if (statusBar) statusBar.dispose();
    if (provider) provider.dispose();
    sandbox.restore();
  });

  test("status bar skips blame for CSV file over csvLineLimit", async () => {
    const testUri = Uri.file("/test/big.csv");
    blameStateManager.setBlameEnabled(testUri, true);
    const mockRepo = makeMockRepo(sandbox);
    const scm = sandbox.createStubInstance(SourceControlManager);
    (scm as any).openRepositories = [];
    scm.getRepositoryFromUri.returns(mockRepo as any);

    statusBar = new BlameStatusBar(scm as any);
    const mockEditor = makeMockEditor(testUri, 1000); // > 500 default limit
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    await statusBar.updateStatusBar();
    await new Promise(r => setTimeout(r, 200));

    assert.ok(
      mockRepo.blame.notCalled,
      "status bar must not blame an over-limit CSV"
    );
  });

  test("status bar skips blame for file over largeFileLimit", async () => {
    const testUri = Uri.file("/test/huge.log");
    blameStateManager.setBlameEnabled(testUri, true);
    const mockRepo = makeMockRepo(sandbox);
    const scm = sandbox.createStubInstance(SourceControlManager);
    (scm as any).openRepositories = [];
    scm.getRepositoryFromUri.returns(mockRepo as any);

    statusBar = new BlameStatusBar(scm as any);
    const mockEditor = makeMockEditor(testUri, 5000); // > 3000 default limit
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    await statusBar.updateStatusBar();
    await new Promise(r => setTimeout(r, 200));

    assert.ok(
      mockRepo.blame.notCalled,
      "status bar must not blame a file over largeFileLimit"
    );
  });

  test("status bar skips repeat selection events on the same line", async () => {
    const testUri = Uri.file("/test/file.txt");
    blameStateManager.setBlameEnabled(testUri, true);
    const mockRepo = makeMockRepo(sandbox);
    const scm = sandbox.createStubInstance(SourceControlManager);
    (scm as any).openRepositories = [];
    scm.getRepositoryFromUri.returns(mockRepo as any);

    statusBar = new BlameStatusBar(scm as any);
    const mockEditor = makeMockEditor(testUri, 10);
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    const fire = () =>
      (statusBar as any).onSelectionChanged({ textEditor: mockEditor });

    fire();
    await new Promise(r => setTimeout(r, 400)); // let debounce settle
    fire(); // same line again
    await new Promise(r => setTimeout(r, 400));

    assert.strictEqual(
      mockRepo.blame.callCount,
      1,
      "same-line selection events must not re-run the blame pipeline"
    );
  });

  test("status bar recovers when a gated file shrinks below the limit", async () => {
    const testUri = Uri.file("/test/big.csv");
    blameStateManager.setBlameEnabled(testUri, true);
    const mockRepo = makeMockRepo(sandbox);
    const scm = sandbox.createStubInstance(SourceControlManager);
    (scm as any).openRepositories = [];
    scm.getRepositoryFromUri.returns(mockRepo as any);

    statusBar = new BlameStatusBar(scm as any);
    const mockEditor = makeMockEditor(testUri, 1000); // > 500 default limit
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    const fire = () =>
      (statusBar as any).onSelectionChanged({ textEditor: mockEditor });

    fire();
    await new Promise(r => setTimeout(r, 400));
    assert.ok(mockRepo.blame.notCalled, "over-limit CSV stays gated");

    // User deletes most rows; cursor stays on the same line number
    mockEditor.document.lineCount = 100;
    fire();
    await new Promise(r => setTimeout(r, 400));

    assert.strictEqual(
      mockRepo.blame.callCount,
      1,
      "gate must re-evaluate once the file is under the limit"
    );
  });

  test("provider cursor path skips blame for over-limit CSV", async () => {
    const testUri = Uri.file("/test/big.csv");
    blameStateManager.setBlameEnabled(testUri, true);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);

    const mockRepository = sandbox.createStubInstance(Repository);
    (mockRepository as any).repository = {
      workspaceRoot: "/test",
      root: "/test"
    };
    provider = new BlameProvider(scmFor(mockRepository as any));

    const mockEditor = makeMockEditor(testUri, 1000); // > 500 default limit
    sandbox.stub(window, "activeTextEditor").value(mockEditor);

    await (provider as any).updateInlineDecorationsForCursor(mockEditor);

    assert.ok(
      mockRepository.blame.notCalled,
      "cursor path must not blame an over-limit CSV the main path refused"
    );
  });
});
