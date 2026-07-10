import * as assert from "assert";
import * as sinon from "sinon";
import { SourceControlInputBox, Uri, window } from "vscode";
import { CommitAll } from "../../commands/commitAll";
import { Status } from "../../common/types";
import { configuration } from "../../helpers/configuration";
import { Repository } from "../../repository";
import { Resource } from "../../resource";
import { CommitFlowService } from "../../services/commitFlowService";

suite("CommitAll Command E2E Tests", () => {
  let commitAllCmd: CommitAll;
  let mockRepository: Partial<Repository>;
  let mockInputBox: Partial<SourceControlInputBox>;
  let runCommitFlowStub: sinon.SinonStub;
  let statusBarStub: sinon.SinonStub;
  let showErrorStub: sinon.SinonStub;
  let commitFilesCalls: Array<{ message: string; paths: string[] }>;

  setup(() => {
    commitAllCmd = new CommitAll();
    commitFilesCalls = [];

    mockInputBox = { value: "" };

    mockRepository = {
      root: "/test/workspace",
      workspaceRoot: "/test/workspace",
      inputBox: mockInputBox as SourceControlInputBox,
      staged: { resourceStates: [] } as any,
      changes: { resourceStates: [] } as any,
      getResourceFromFile: (_path: string) => undefined,
      stageOptimistic: async (_paths: string[]) => {},
      commitFiles: async (message: string, paths: string[]) => {
        commitFilesCalls.push({ message, paths });
        return "Revision 42: commit successful";
      },
      staging: {
        clearOriginalChangelists: (_paths: string[]) => {}
      } as any
    };

    runCommitFlowStub = sinon
      .stub(CommitFlowService.prototype, "runCommitFlow")
      .callsFake(async (_repository, filePaths: string[]) => ({
        cancelled: false,
        message: "Commit all changes",
        selectedFiles: filePaths
      }));

    // Success/no-op confirmations are inline status-bar feedback
    statusBarStub = sinon.stub(window, "setStatusBarMessage");
    showErrorStub = sinon.stub(window, "showErrorMessage").resolves(undefined);

    sinon.stub(configuration, "commitUseQuickPick").returns(true);
    sinon.stub(configuration, "commitAutoUpdate").returns("none");
  });

  teardown(() => {
    commitAllCmd.dispose();
    sinon.restore();
  });

  test("Commit all success - staged files committed", async () => {
    const file1 = new Resource(
      Uri.file("/test/workspace/file1.txt"),
      Status.MODIFIED
    );
    const file2 = new Resource(
      Uri.file("/test/workspace/file2.txt"),
      Status.ADDED
    );
    const file3 = new Resource(
      Uri.file("/test/workspace/file3.txt"),
      Status.DELETED
    );

    (mockRepository as any).staged.resourceStates = [file1, file2, file3];
    (mockRepository as any).changes.resourceStates = [];

    const clearOriginalStub = sinon.spy(
      (mockRepository as any).staging,
      "clearOriginalChangelists"
    );

    mockRepository.commitFiles = async (message: string, paths: string[]) => {
      commitFilesCalls.push({ message, paths });
      return "Revision 42: 3 files committed";
    };

    await commitAllCmd.execute(mockRepository as Repository);

    assert.ok(runCommitFlowStub.calledOnce);
    assert.strictEqual(commitFilesCalls.length, 1);
    assert.strictEqual(commitFilesCalls[0]!.message, "Commit all changes");
    assert.strictEqual(commitFilesCalls[0]!.paths.length, 3);
    assert.ok(commitFilesCalls[0]!.paths.includes(file1.resourceUri.fsPath));
    assert.ok(commitFilesCalls[0]!.paths.includes(file2.resourceUri.fsPath));
    assert.ok(commitFilesCalls[0]!.paths.includes(file3.resourceUri.fsPath));
    assert.ok(
      statusBarStub.calledWith(
        "Revision 42: 3 files committed",
        sinon.match.number
      )
    );
    assert.strictEqual((mockRepository.inputBox as any).value, "");
    assert.ok(clearOriginalStub.calledOnce);
  });

  test("Commit empty - no staged and no changes", async () => {
    (mockRepository as any).staged.resourceStates = [];
    (mockRepository as any).changes.resourceStates = [];

    await commitAllCmd.execute(mockRepository as Repository);

    assert.ok(
      statusBarStub.calledWith("No changes to commit", sinon.match.number)
    );
    assert.ok(runCommitFlowStub.notCalled);
    assert.strictEqual(commitFilesCalls.length, 0);
  });

  test("Commit error - shows actionable error message", async () => {
    const file = new Resource(
      Uri.file("/test/workspace/error.txt"),
      Status.MODIFIED
    );
    (mockRepository as any).staged.resourceStates = [file];
    (mockRepository as any).changes.resourceStates = [];

    runCommitFlowStub.resolves({
      cancelled: false,
      message: "Commit message",
      selectedFiles: [file.resourceUri.fsPath]
    });
    mockRepository.commitFiles = async () => {
      throw new Error("svn: E155015: Commit failed");
    };

    await commitAllCmd.execute(mockRepository as Repository);

    assert.ok(runCommitFlowStub.calledOnce);
    assert.ok(showErrorStub.calledOnce);
    // E155015 is a conflict error — routes to "Resolve Conflicts"
    assert.ok(
      showErrorStub.firstCall.args[0].includes("Conflict blocking operation")
    );
    assert.strictEqual(showErrorStub.firstCall.args[1], "Resolve Conflicts");
  });
});
