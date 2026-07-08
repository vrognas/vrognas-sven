import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: vi.fn(() => ({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      text: "",
      tooltip: "",
      command: ""
    }))
  },
  StatusBarAlignment: { Left: 1 }
}));

import { LockStatusBar } from "../../../src/statusbar/lockStatusBar";
import { SourceControlManager } from "../../../src/source_control_manager";

// Expose protected update() for direct invocation in tests
class TestLockStatusBar extends LockStatusBar {
  public override update(): void {
    super.update();
  }
}

// Mock Repository
function createMockRepository(lockedCount: number) {
  return {
    getLockedFileCount: vi.fn(() => lockedCount),
    onDidChangeLockStatus: vi.fn(() => ({ dispose: vi.fn() }))
  };
}

// Mock SourceControlManager
function createMockSCM(
  repositories: ReturnType<typeof createMockRepository>[]
): SourceControlManager {
  return {
    repositories,
    onDidOpenRepository: vi.fn(() => ({ dispose: vi.fn() })),
    onDidCloseRepository: vi.fn(() => ({ dispose: vi.fn() }))
  } as unknown as SourceControlManager;
}

describe("LockStatusBar", () => {
  let statusBar: TestLockStatusBar;
  let mockSCM: SourceControlManager;

  beforeEach(() => {
    mockSCM = createMockSCM([createMockRepository(0)]);
    statusBar = new TestLockStatusBar(mockSCM);
  });

  describe("display states", () => {
    it("shows count when files are locked", () => {
      mockSCM = createMockSCM([createMockRepository(3)]);
      statusBar = new TestLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getText()).toBe("$(lock) 3");
    });

    it("hides when no files are locked", () => {
      mockSCM = createMockSCM([createMockRepository(0)]);
      statusBar = new TestLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.isVisible()).toBe(false);
    });

    it("shows singular tooltip for 1 file", () => {
      mockSCM = createMockSCM([createMockRepository(1)]);
      statusBar = new TestLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getTooltip()).toBe("1 locked item");
    });

    it("shows plural tooltip for multiple files", () => {
      mockSCM = createMockSCM([createMockRepository(5)]);
      statusBar = new TestLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getTooltip()).toBe("5 locked items");
    });

    it("aggregates count from multiple repositories", () => {
      mockSCM = createMockSCM([
        createMockRepository(2),
        createMockRepository(4)
      ]);
      statusBar = new TestLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getText()).toBe("$(lock) 6");
    });
  });

  describe("dispose", () => {
    it("disposes status bar item", () => {
      statusBar.dispose();
      // Should not throw
    });
  });
});
