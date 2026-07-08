import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CommitFlowService,
  ICommitMessageInput
} from "../../../src/services/commitFlowService";
import { ConventionalCommitService } from "../../../src/services/conventionalCommitService";
import { IPreCommitUpdateRepository } from "../../../src/services/preCommitUpdateService";
import type { Resource } from "../../../src/resource";

const mockWindow = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  withProgress: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn()
}));

// Mock vscode
vi.mock("vscode", () => ({
  window: mockWindow,
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 }
}));

/** Partial Resource stub — only `type` is read by PreCommitUpdateService. */
function resourceStub(type: string): Resource {
  const stub: Partial<Resource> = { type };
  return stub as Resource;
}

function createMockRepository() {
  return {
    inputBox: { value: "" },
    hasRemoteChanges: vi
      .fn<IPreCommitUpdateRepository["hasRemoteChanges"]>()
      .mockResolvedValue(true),
    updateRevision: vi
      .fn<IPreCommitUpdateRepository["updateRevision"]>()
      .mockResolvedValue({
        revision: 100,
        conflicts: [],
        message: "Updated to revision 100"
      }),
    getLastRemoteCheckResult: vi
      .fn<IPreCommitUpdateRepository["getLastRemoteCheckResult"]>()
      .mockReturnValue(undefined),
    getRemoteCheckFrequencyMs: vi
      .fn<IPreCommitUpdateRepository["getRemoteCheckFrequencyMs"]>()
      .mockReturnValue(300_000),
    getResourceFromFile: vi
      .fn<IPreCommitUpdateRepository["getResourceFromFile"]>()
      .mockReturnValue(resourceStub("modified")),
    isInsideUnversionedOrIgnored: vi
      .fn<IPreCommitUpdateRepository["isInsideUnversionedOrIgnored"]>()
      .mockReturnValue(undefined)
  } satisfies ICommitMessageInput & IPreCommitUpdateRepository;
}

describe("CommitFlowService", () => {
  let service: CommitFlowService;
  let mockRepository: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    // Reset ALL mock state before each test (including implementations)
    vi.resetAllMocks();

    mockRepository = createMockRepository();

    service = new CommitFlowService(new ConventionalCommitService());
  });

  describe("runCommitFlow", () => {
    it("returns cancelled when user cancels type selection", async () => {
      mockWindow.showQuickPick.mockResolvedValueOnce(undefined);

      const result = await service.runCommitFlow(mockRepository, [
        "/path/file.txt"
      ]);

      expect(result.cancelled).toBe(true);
      expect(result.message).toBeUndefined();
    });

    it("skips scope step when custom type selected", async () => {
      // Select custom type
      mockWindow.showQuickPick.mockResolvedValueOnce({ type: "custom" });
      // Enter custom message
      mockWindow.showInputBox.mockResolvedValueOnce("my custom message");
      // Confirm commit
      mockWindow.showQuickPick.mockResolvedValueOnce({ action: "commit" });

      const result = await service.runCommitFlow(mockRepository, [
        "/path/file.txt"
      ]);

      expect(result.message).toBe("my custom message");
    });

    it("includes scope in message when provided", async () => {
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "feat", label: "feat" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("ui")
        .mockResolvedValueOnce("add button");

      const result = await service.runCommitFlow(
        mockRepository,
        ["/path/file.txt"],
        { conventionalCommits: true }
      );

      expect(result.message).toBe("feat(ui): add button");
    });

    it("allows empty scope", async () => {
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "fix", label: "fix" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("resolve crash");

      const result = await service.runCommitFlow(
        mockRepository,
        ["/path/file.txt"],
        { conventionalCommits: true }
      );

      expect(result.message).toBe("fix: resolve crash");
    });

    it("shows previous messages in type picker", async () => {
      mockRepository.inputBox.value = "feat: previous message";
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "feat", label: "feat" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("new feature");

      await service.runCommitFlow(mockRepository, ["/path/file.txt"], {
        conventionalCommits: true
      });

      // Verify previous message option was in picker
      const pickerCall = mockWindow.showQuickPick.mock.calls[0];
      expect(
        pickerCall[0].some((item: { label?: string }) =>
          item.label?.includes("previous")
        )
      ).toBe(true);
    });
  });

  describe("pre-commit update", () => {
    it("runs update before commit when enabled", async () => {
      mockWindow.withProgress.mockImplementation(
        async (
          _opts: unknown,
          task: (p: unknown, t: unknown) => Promise<unknown>
        ) => {
          return task({ report: vi.fn() }, { isCancellationRequested: false });
        }
      );
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "feat", label: "feat" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("add feature");

      await service.runCommitFlow(mockRepository, ["/path/file.txt"], {
        updateBeforeCommit: true
      });

      expect(mockRepository.updateRevision).toHaveBeenCalled();
    });

    it("skips update when all files are unversioned/added", async () => {
      mockRepository.getResourceFromFile.mockReturnValue(resourceStub("added"));
      mockWindow.showInputBox.mockResolvedValueOnce("add new files");

      const result = await service.runCommitFlow(
        mockRepository,
        ["/path/new.txt"],
        {
          updateBeforeCommit: true
        }
      );

      expect(mockRepository.updateRevision).not.toHaveBeenCalled();
      expect(result.message).toBe("add new files");
    });

    it("passes committed file paths to targeted update", async () => {
      mockWindow.withProgress.mockImplementation(
        async (
          _opts: unknown,
          task: (p: unknown, t: unknown) => Promise<unknown>
        ) => {
          return task({ report: vi.fn() }, { isCancellationRequested: false });
        }
      );
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "fix", label: "fix" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("fix bug");

      await service.runCommitFlow(mockRepository, ["/path/file.txt"], {
        updateBeforeCommit: true
      });

      // updateRevision should receive the file paths
      expect(mockRepository.updateRevision).toHaveBeenCalledWith(
        false,
        expect.objectContaining({ files: ["/path/file.txt"] })
      );
    });

    it("prompts user on update conflict after message flow", async () => {
      mockRepository.updateRevision.mockResolvedValueOnce({
        revision: 50,
        conflicts: ["/test/repo/file.txt"],
        message: "Updated with conflicts"
      });
      mockWindow.showWarningMessage.mockResolvedValueOnce("Abort");
      mockWindow.withProgress.mockImplementation(
        async (
          _opts: unknown,
          task: (p: unknown, t: unknown) => Promise<unknown>
        ) => {
          return task({ report: vi.fn() }, { isCancellationRequested: false });
        }
      );
      // Message flow completes before update result is checked
      mockWindow.showInputBox.mockResolvedValueOnce("test message");

      const result = await service.runCommitFlow(
        mockRepository,
        ["/path/file.txt"],
        {
          updateBeforeCommit: true
        }
      );

      // Non-modal warning (3 args, no modal options object)
      expect(mockWindow.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("Conflicts"),
        expect.anything(),
        expect.anything()
      );
      expect(result.cancelled).toBe(true);
    });

    it("continues commit after resolving conflicts when user chooses", async () => {
      mockRepository.updateRevision.mockResolvedValueOnce({
        revision: 50,
        conflicts: ["/test/repo/file.txt"],
        message: "Updated with conflicts"
      });
      mockWindow.showWarningMessage.mockResolvedValueOnce("Commit Anyway");
      mockWindow.withProgress.mockImplementation(
        async (
          _opts: unknown,
          task: (p: unknown, t: unknown) => Promise<unknown>
        ) => {
          return task({ report: vi.fn() }, { isCancellationRequested: false });
        }
      );
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "fix", label: "fix" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("fix bug");

      const result = await service.runCommitFlow(
        mockRepository,
        ["/path/file.txt"],
        {
          updateBeforeCommit: true,
          conventionalCommits: true
        }
      );

      expect(result.message).toBe("fix: fix bug");
    });
  });

  describe("file selection step", () => {
    it("shows file picker with all files selected by default", async () => {
      // File selection (canPickMany) - simulate selecting all files
      mockWindow.showQuickPick.mockResolvedValueOnce([
        { label: "file1.txt", filePath: "/a/file1.txt", picked: true },
        { label: "file2.txt", filePath: "/a/file2.txt", picked: true }
      ]);
      // Type selection
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "feat", label: "feat" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("add files");

      const result = await service.runCommitFlow(mockRepository, [
        "/a/file1.txt",
        "/a/file2.txt"
      ]);

      expect(result.cancelled).toBe(false);
      expect(result.selectedFiles).toHaveLength(2);
    });

    it("allows user to deselect files", async () => {
      // User only selects one file
      mockWindow.showQuickPick.mockResolvedValueOnce([
        { label: "file1.txt", filePath: "/a/file1.txt", picked: true }
      ]);
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "fix", label: "fix" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("fix bug");

      const result = await service.runCommitFlow(mockRepository, [
        "/a/file1.txt",
        "/a/file2.txt"
      ]);

      expect(result.selectedFiles).toHaveLength(1);
      expect(result.selectedFiles![0]).toBe("/a/file1.txt");
    });

    it("cancels when no files selected", async () => {
      mockWindow.showQuickPick.mockResolvedValueOnce([]);

      const result = await service.runCommitFlow(mockRepository, [
        "/a/file1.txt"
      ]);

      expect(result.cancelled).toBe(true);
    });

    it("cancels when file picker dismissed", async () => {
      mockWindow.showQuickPick.mockResolvedValueOnce(undefined);

      const result = await service.runCommitFlow(mockRepository, [
        "/a/file1.txt"
      ]);

      expect(result.cancelled).toBe(true);
    });
  });

  describe("confirmation step", () => {
    it("shows file count in confirm step", async () => {
      // File selection (3 files - need picker)
      mockWindow.showQuickPick.mockResolvedValueOnce([
        { filePath: "/a.txt" },
        { filePath: "/b.txt" },
        { filePath: "/c.txt" }
      ]);
      // Type and confirm
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "feat", label: "feat" })
        .mockResolvedValueOnce({ action: "commit" });
      mockWindow.showInputBox
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("add files");

      await service.runCommitFlow(
        mockRepository,
        ["/a.txt", "/b.txt", "/c.txt"],
        { conventionalCommits: true }
      );

      // Index 2: file picker (0) -> type (1) -> confirm (2)
      const confirmCall = mockWindow.showQuickPick.mock.calls[2];
      expect(
        confirmCall[0].some(
          (item: { label?: string; description?: string }) =>
            item.label?.includes("3") || item.description?.includes("3")
        )
      ).toBe(true);
    });

    it("allows going back to edit message", async () => {
      // Edit only re-prompts for description, not scope
      mockWindow.showQuickPick
        .mockResolvedValueOnce({ type: "feat", label: "feat" })
        .mockResolvedValueOnce({ action: "edit" }) // Go back
        .mockResolvedValueOnce({ action: "commit" }); // Then commit
      mockWindow.showInputBox
        .mockResolvedValueOnce("") // Scope
        .mockResolvedValueOnce("first attempt") // Description 1
        .mockResolvedValueOnce("corrected message"); // Description 2 (after edit)

      const result = await service.runCommitFlow(
        mockRepository,
        ["/path/file.txt"],
        { conventionalCommits: true }
      );

      expect(result.message).toBe("feat: corrected message");
    });
  });
});
