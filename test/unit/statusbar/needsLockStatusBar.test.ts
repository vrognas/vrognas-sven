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

import { NeedsLockStatusBar } from "../../../src/statusbar/needsLockStatusBar";
import { SourceControlManager } from "../../../src/source_control_manager";

// Expose protected update() for testing
class TestNeedsLockStatusBar extends NeedsLockStatusBar {
  public update(): void {
    super.update();
  }
}

// Mock Repository
function createMockRepository(needsLockCount: number) {
  return {
    getNeedsLockCount: vi.fn(() => needsLockCount),
    onDidChangeNeedsLock: vi.fn(() => ({ dispose: vi.fn() }))
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

describe("NeedsLockStatusBar", () => {
  let statusBar: TestNeedsLockStatusBar;
  let mockSCM: SourceControlManager;

  beforeEach(() => {
    mockSCM = createMockSCM([createMockRepository(0)]);
    statusBar = new TestNeedsLockStatusBar(mockSCM);
  });

  describe("display states", () => {
    it("shows count when files need lock", () => {
      mockSCM = createMockSCM([createMockRepository(5)]);
      statusBar = new TestNeedsLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getText()).toBe("$(unlock) 5");
    });

    it("hides when no files need lock", () => {
      mockSCM = createMockSCM([createMockRepository(0)]);
      statusBar = new TestNeedsLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.isVisible()).toBe(false);
    });

    it("shows singular tooltip for 1 file", () => {
      mockSCM = createMockSCM([createMockRepository(1)]);
      statusBar = new TestNeedsLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getTooltip()).toBe("1 item needs lock");
    });

    it("shows plural tooltip for multiple files", () => {
      mockSCM = createMockSCM([createMockRepository(3)]);
      statusBar = new TestNeedsLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getTooltip()).toBe("3 items need lock");
    });

    it("aggregates count from multiple repositories", () => {
      mockSCM = createMockSCM([
        createMockRepository(2),
        createMockRepository(3)
      ]);
      statusBar = new TestNeedsLockStatusBar(mockSCM);

      statusBar.update();

      expect(statusBar.getText()).toBe("$(unlock) 5");
    });
  });

  describe("dispose", () => {
    it("disposes status bar item", () => {
      statusBar.dispose();
      // Should not throw
    });
  });
});
