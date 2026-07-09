import * as assert from "assert";
import { SourceControlInputBox, Uri, window, workspace } from "vscode";
import { vi } from "vitest";
import { Commit } from "../../../commands/commit";
import { CommitWithMessage } from "../../../commands/commitWithMessage";
import { Status } from "../../../common/types";
import { inputCommitFiles } from "../../../changelistItems";
import { inputCommitMessage } from "../../../messages";
import { Repository } from "../../../repository";
import { Resource } from "../../../resource";

vi.mock("../../../messages", () => ({
  inputCommitMessage: vi.fn()
}));

vi.mock("../../../changelistItems", () => ({
  inputCommitFiles: vi.fn()
}));

suite("Commit Commands Tests", () => {
  let mockRepository: Partial<Repository>;
  let mockInputBox: Partial<SourceControlInputBox>;
  let commitFilesCalls: Array<{ message: string; paths: string[] }>;

  function createStagedResource(path: string): Resource {
    return new Resource(
      Uri.file(path),
      Status.MODIFIED,
      undefined,
      undefined,
      false,
      false,
      undefined,
      false,
      undefined,
      "staged"
    );
  }

  setup(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    commitFilesCalls = [];
    mockInputBox = { value: "" };
    // The pre-commit update gate (default autoUpdate="both") is covered
    // by commitFlowService tests; these target message flow + commitFiles
    void workspace.getConfiguration("sven").update("commit.autoUpdate", "none");

    mockRepository = {
      root: "/test/repo",
      workspaceRoot: "/test/repo",
      inputBox: mockInputBox as SourceControlInputBox,
      getResourceFromFile: () => undefined,
      commitFiles: async (message: string, paths: string[]) => {
        commitFilesCalls.push({ message, paths });
        return "Revision 42";
      },
      staging: {
        clearOriginalChangelists: () => {}
      } as any
    };
  });

  teardown(() => {
    void workspace
      .getConfiguration("sven")
      .update("commit.autoUpdate", undefined);
  });

  test("Commit exits with warning when files are not staged", async () => {
    const commit = new Commit();
    const warningSpy = vi.fn().mockResolvedValue(undefined);
    (window as any).showWarningMessage = warningSpy;

    const resource = new Resource(
      Uri.file("/test/repo/file.txt"),
      Status.MODIFIED
    );
    (commit as any).getResourceStatesOrExit = async () => [resource];
    vi.mocked(inputCommitMessage).mockResolvedValue("message");

    await commit.execute(resource);

    assert.strictEqual(warningSpy.mock.calls.length, 1);
    assert.strictEqual(vi.mocked(inputCommitMessage).mock.calls.length, 0);
    assert.strictEqual(commitFilesCalls.length, 0);
    commit.dispose();
  });

  test("Commit exits when selection is empty", async () => {
    const commit = new Commit();
    (commit as any).getResourceStatesOrExit = async () => null;
    vi.mocked(inputCommitMessage).mockResolvedValue("message");

    await commit.execute();

    assert.strictEqual(vi.mocked(inputCommitMessage).mock.calls.length, 0);
    assert.strictEqual(commitFilesCalls.length, 0);
    commit.dispose();
  });

  test("Commit commits selected staged resources when message is provided", async () => {
    const commit = new Commit();
    const resource = createStagedResource("/test/repo/file.txt");

    vi.mocked(inputCommitMessage).mockResolvedValue("fix: staged file");
    (commit as any).runBySelectionPaths = async (_selection: any, fn: any) => {
      await fn(mockRepository, [resource.resourceUri.fsPath]);
    };

    await commit.execute(resource);

    assert.strictEqual(commitFilesCalls.length, 1);
    assert.strictEqual(commitFilesCalls[0]!.message, "fix: staged file");
    assert.deepStrictEqual(commitFilesCalls[0]!.paths, [
      resource.resourceUri.fsPath
    ]);
    assert.strictEqual((mockRepository.inputBox as any).value, "");
    commit.dispose();
  });

  test("CommitWithMessage exits when no files are selected", async () => {
    const command = new CommitWithMessage();
    vi.mocked(inputCommitMessage).mockClear();
    vi.mocked(inputCommitFiles).mockResolvedValue(undefined);
    vi.mocked(inputCommitMessage).mockResolvedValue("message");

    await command.execute(mockRepository as Repository);

    assert.strictEqual(vi.mocked(inputCommitMessage).mock.calls.length, 0);
    assert.strictEqual(commitFilesCalls.length, 0);
    command.dispose();
  });

  test("CommitWithMessage commits selected files with promptNew=false", async () => {
    const command = new CommitWithMessage();
    const resource = createStagedResource("/test/repo/file.txt");

    vi.mocked(inputCommitFiles).mockResolvedValue([resource]);
    vi.mocked(inputCommitMessage).mockImplementation(
      async (_msg?: string, promptNew?: boolean, filePaths?: string[]) => {
        assert.strictEqual(promptNew, false);
        assert.ok(Array.isArray(filePaths));
        assert.ok(filePaths!.includes(resource.resourceUri.fsPath));
        return "feat: commit selected";
      }
    );

    await command.execute(mockRepository as Repository);

    assert.strictEqual(commitFilesCalls.length, 1);
    assert.strictEqual(commitFilesCalls[0]!.message, "feat: commit selected");
    assert.deepStrictEqual(commitFilesCalls[0]!.paths, [
      resource.resourceUri.fsPath
    ]);
    command.dispose();
  });
});
