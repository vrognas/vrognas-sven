import { describe, it, expect, vi } from "vitest";
import { Disposable, StatusBarAlignment } from "vscode";

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
  StatusBarAlignment: { Left: 1, Right: 2 }
}));

import {
  BaseStatusBar,
  StatusBarConfig
} from "../../../src/statusbar/baseStatusBar";
import { SourceControlManager } from "../../../src/source_control_manager";
import { Repository } from "../../../src/repository";

// Concrete implementation for testing
class TestStatusBar extends BaseStatusBar {
  public updateCallCount = 0;
  protected getRepoEvent(_repo: Repository): (cb: () => void) => Disposable {
    return (cb: () => void) => {
      cb(); // Call immediately for test
      return { dispose: vi.fn() };
    };
  }

  protected update(): void {
    this.updateCallCount++;
  }
}

// Mock Repository factory
function createMockRepository(): Partial<Repository> {
  return {
    onDidChangeStatus: vi.fn(() => ({ dispose: vi.fn() }))
  };
}

// Mock SourceControlManager factory
function createMockSCM(
  repositories: Partial<Repository>[]
): SourceControlManager {
  const openHandlers: ((repo: Repository) => void)[] = [];
  const closeHandlers: ((repo: Repository) => void)[] = [];

  return {
    repositories,
    onDidOpenRepository: vi.fn(handler => {
      openHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    onDidCloseRepository: vi.fn(handler => {
      closeHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    // Test helpers
    _triggerOpen: (repo: Repository) => openHandlers.forEach(h => h(repo)),
    _triggerClose: (repo: Repository) => closeHandlers.forEach(h => h(repo))
  } as unknown as SourceControlManager & {
    _triggerOpen: (repo: Repository) => void;
    _triggerClose: (repo: Repository) => void;
  };
}

describe("BaseStatusBar", () => {
  const defaultConfig: StatusBarConfig = {
    id: "test.statusBar",
    alignment: StatusBarAlignment.Left,
    priority: 50
  };

  describe("constructor", () => {
    it("creates status bar without error", () => {
      const repos = [createMockRepository(), createMockRepository()];
      const scm = createMockSCM(repos);

      const statusBar = new TestStatusBar(scm, defaultConfig);

      // Should create successfully
      expect(statusBar).toBeDefined();
      statusBar.dispose();
    });

    it("subscribes to onDidOpenRepository", () => {
      const scm = createMockSCM([]);

      new TestStatusBar(scm, defaultConfig);

      expect(scm.onDidOpenRepository).toHaveBeenCalled();
    });

    it("subscribes to onDidCloseRepository", () => {
      const scm = createMockSCM([]);

      new TestStatusBar(scm, defaultConfig);

      expect(scm.onDidCloseRepository).toHaveBeenCalled();
    });
  });

  describe("repository lifecycle", () => {
    it("subscribes to new repositories when opened", () => {
      const scm = createMockSCM([]) as SourceControlManager & {
        _triggerOpen: (repo: Repository) => void;
      };
      const statusBar = new TestStatusBar(scm, defaultConfig);

      const initialCount = statusBar.updateCallCount;
      const newRepo = createMockRepository() as Repository;
      scm._triggerOpen(newRepo);

      expect(statusBar.updateCallCount).toBeGreaterThan(initialCount);
      statusBar.dispose();
    });

    it("cleans up subscription when repository closed", () => {
      const repo = createMockRepository() as Repository;
      const scm = createMockSCM([repo]) as SourceControlManager & {
        _triggerClose: (repo: Repository) => void;
      };
      const statusBar = new TestStatusBar(scm, defaultConfig);

      const initialCount = statusBar.updateCallCount;
      scm._triggerClose(repo);

      // Should call update after cleanup
      expect(statusBar.updateCallCount).toBeGreaterThan(initialCount);
      statusBar.dispose();
    });
  });

  describe("dispose", () => {
    it("disposes without error", () => {
      const scm = createMockSCM([createMockRepository()]);
      const statusBar = new TestStatusBar(scm, defaultConfig);

      expect(() => statusBar.dispose()).not.toThrow();
    });

    it("cleans up all subscriptions", () => {
      const repos = [createMockRepository(), createMockRepository()];
      const scm = createMockSCM(repos);
      const statusBar = new TestStatusBar(scm, defaultConfig);

      statusBar.dispose();

      // Should not throw on second dispose
      expect(() => statusBar.dispose()).not.toThrow();
    });
  });
});
