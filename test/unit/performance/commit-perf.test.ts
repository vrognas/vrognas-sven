import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PreCommitUpdateService,
  IPreCommitUpdateRepository
} from "../../../src/services/preCommitUpdateService";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    withProgress: vi.fn(),
    showWarningMessage: vi.fn()
  },
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn() }
}));

interface MockRepoOptions {
  hasRemoteChanges: boolean;
  updateResult?: { revision: number; conflicts: string[]; message: string };
  lastRemoteCheckResult?: { hasChanges: boolean; timestamp: number };
}

function createMockRepo(opts: MockRepoOptions): IPreCommitUpdateRepository {
  return {
    getResourceFromFile: vi.fn().mockReturnValue(undefined),
    isInsideUnversionedOrIgnored: vi.fn().mockReturnValue(undefined),
    hasRemoteChanges: vi.fn().mockResolvedValue(opts.hasRemoteChanges),
    updateRevision: vi.fn().mockResolvedValue(opts.updateResult),
    getLastRemoteCheckResult: vi
      .fn()
      .mockReturnValue(opts.lastRemoteCheckResult),
    getRemoteCheckFrequencyMs: vi.fn().mockReturnValue(300_000)
  };
}

describe("Commit workflow performance", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const vscode = await import("vscode");
    vi.mocked(vscode.window.withProgress).mockImplementation((_opts, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => undefined })
        }
      )
    );
  });

  describe("PreCommitUpdateService cached remote check", () => {
    it("skips hasRemoteChanges call when fresh cached result is false", async () => {
      const service = new PreCommitUpdateService();
      const mockRepo = createMockRepo({
        hasRemoteChanges: true,
        updateResult: { revision: 100, conflicts: [], message: "Updated" },
        lastRemoteCheckResult: {
          hasChanges: false,
          timestamp: Date.now() // fresh
        }
      });

      const result = await service.runUpdate(mockRepo);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(mockRepo.hasRemoteChanges).not.toHaveBeenCalled();
    });

    it("calls hasRemoteChanges when cached result is stale", async () => {
      const service = new PreCommitUpdateService();
      const mockRepo = createMockRepo({
        hasRemoteChanges: false,
        lastRemoteCheckResult: {
          hasChanges: false,
          timestamp: Date.now() - 600_000 // 10 min ago, stale
        }
      });

      await service.runUpdate(mockRepo);

      expect(mockRepo.hasRemoteChanges).toHaveBeenCalled();
    });

    it("falls back to hasRemoteChanges when no cached result", async () => {
      const service = new PreCommitUpdateService();
      const mockRepo = createMockRepo({
        hasRemoteChanges: true,
        updateResult: { revision: 50, conflicts: [], message: "Updated" },
        lastRemoteCheckResult: undefined
      });

      await service.runUpdate(mockRepo);

      expect(mockRepo.hasRemoteChanges).toHaveBeenCalled();
      expect(mockRepo.updateRevision).toHaveBeenCalled();
    });
  });
});
