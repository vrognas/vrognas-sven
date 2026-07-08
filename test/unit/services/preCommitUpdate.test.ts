import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mocked } from "vitest";
import {
  PreCommitUpdateService,
  IPreCommitUpdateRepository
} from "../../../src/services/preCommitUpdateService";

// Hoisted so the vi.mock factory and tests share the same mock instances,
// with a concrete type instead of casting the real vscode module shape.
const mockWindow = vi.hoisted(() => ({
  withProgress: vi.fn(),
  showWarningMessage: vi.fn()
}));

// Mock vscode
vi.mock("vscode", () => ({
  window: mockWindow,
  ProgressLocation: { Notification: 15 },
  CancellationTokenSource: vi.fn().mockImplementation(() => ({
    token: { isCancellationRequested: false },
    cancel: vi.fn(),
    dispose: vi.fn()
  }))
}));

describe("PreCommitUpdateService", () => {
  let service: PreCommitUpdateService;
  let mockRepository: Mocked<IPreCommitUpdateRepository>;

  beforeEach(() => {
    mockRepository = {
      getResourceFromFile: vi.fn(),
      isInsideUnversionedOrIgnored: vi.fn(),
      hasRemoteChanges: vi.fn().mockResolvedValue(true),
      updateRevision: vi.fn(),
      getLastRemoteCheckResult: vi.fn().mockReturnValue(undefined),
      getRemoteCheckFrequencyMs: vi.fn().mockReturnValue(300_000)
    };

    service = new PreCommitUpdateService();

    vi.resetAllMocks();

    // Default: withProgress executes task immediately
    mockWindow.withProgress.mockImplementation(
      async (
        _opts: unknown,
        task: (p: unknown, t: unknown) => Promise<unknown>
      ) => {
        return task({ report: vi.fn() }, { isCancellationRequested: false });
      }
    );
  });

  describe("runUpdate", () => {
    it("returns success when update succeeds", async () => {
      mockRepository.hasRemoteChanges.mockResolvedValueOnce(true);
      mockRepository.updateRevision.mockResolvedValueOnce({
        revision: 100,
        conflicts: [],
        message: "Updated to revision 100"
      });

      const result = await service.runUpdate(mockRepository);

      expect(result.success).toBe(true);
      expect(result.revision).toBe(100);
    });

    it("returns conflict info when conflicts detected", async () => {
      mockRepository.hasRemoteChanges.mockResolvedValueOnce(true);
      mockRepository.updateRevision.mockResolvedValueOnce({
        revision: 50,
        conflicts: ["/test/repo/file.txt"],
        message: "Updated with conflicts"
      });

      const result = await service.runUpdate(mockRepository);

      expect(result.success).toBe(false);
      expect(result.hasConflicts).toBe(true);
    });

    it("shows progress notification during update", async () => {
      mockRepository.hasRemoteChanges.mockResolvedValueOnce(true);
      mockRepository.updateRevision.mockResolvedValueOnce({
        revision: 100,
        conflicts: [],
        message: "Updated to revision 100"
      });

      await service.runUpdate(mockRepository);

      expect(mockWindow.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Checking"),
          location: expect.anything()
        }),
        expect.any(Function)
      );
    });

    it("skips update when no remote changes", async () => {
      mockRepository.hasRemoteChanges.mockResolvedValueOnce(false);

      const result = await service.runUpdate(mockRepository);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(mockRepository.updateRevision).not.toHaveBeenCalled();
    });

    it("returns cancelled when user cancels", async () => {
      mockWindow.withProgress.mockImplementation(
        async (
          _opts: unknown,
          task: (p: unknown, t: unknown) => Promise<unknown>
        ) => {
          return task({ report: vi.fn() }, { isCancellationRequested: true });
        }
      );

      const result = await service.runUpdate(mockRepository);

      expect(result.cancelled).toBe(true);
    });
  });

  describe("promptConflictResolution", () => {
    it("returns abort when user chooses Abort", async () => {
      mockWindow.showWarningMessage.mockResolvedValueOnce("Abort");

      const result = await service.promptConflictResolution();

      expect(result).toBe("abort");
    });

    it("returns continue when user chooses Commit Anyway", async () => {
      mockWindow.showWarningMessage.mockResolvedValueOnce("Commit Anyway");

      const result = await service.promptConflictResolution();

      expect(result).toBe("continue");
    });

    it("returns abort when user dismisses dialog", async () => {
      mockWindow.showWarningMessage.mockResolvedValueOnce(undefined);

      const result = await service.promptConflictResolution();

      expect(result).toBe("abort");
    });

    it("shows appropriate warning message", async () => {
      mockWindow.showWarningMessage.mockResolvedValueOnce("Resolve First");

      await service.promptConflictResolution();

      // Non-modal warning (no modal option object)
      expect(mockWindow.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("Conflicts"),
        "Resolve First",
        "Commit Anyway"
      );
    });
  });
});
