import * as assert from "assert";
import { vi } from "vitest";
import { Uri } from "vscode";
import { BlameStateManager } from "../../../blame/blameStateManager";
import { blameConfiguration } from "../../../blame/blameConfiguration";

suite("BlameStateManager Tests", () => {
  let stateManager: BlameStateManager;
  let testUri: Uri;

  setup(() => {
    stateManager = new BlameStateManager();
    testUri = Uri.file("/test/file.ts");
  });

  teardown(() => {
    stateManager.dispose();
  });

  suite("Per-File State Tracking", () => {
    test("should default to enabled for new files", () => {
      assert.strictEqual(stateManager.isBlameEnabled(testUri), true);
    });

    test("should track blame enabled state for file", () => {
      assert.strictEqual(stateManager.isBlameEnabled(testUri), true);

      stateManager.setBlameEnabled(testUri, false);
      assert.strictEqual(stateManager.isBlameEnabled(testUri), false);
    });

    test("should toggle blame state for file", () => {
      const initialState = stateManager.isBlameEnabled(testUri);
      stateManager.toggleBlame(testUri);
      assert.strictEqual(stateManager.isBlameEnabled(testUri), !initialState);
    });

    test("should clear blame state for file (revert to default)", () => {
      stateManager.setBlameEnabled(testUri, false);
      stateManager.clearBlame(testUri);
      assert.strictEqual(stateManager.isBlameEnabled(testUri), true);
    });
  });

  suite("Multiple Files State", () => {
    test("should track multiple files independently", () => {
      const uri1 = Uri.file("/test/file1.ts");
      const uri2 = Uri.file("/test/file2.ts");

      stateManager.setBlameEnabled(uri1, true);
      stateManager.setBlameEnabled(uri2, false);

      assert.strictEqual(stateManager.isBlameEnabled(uri1), true);
      assert.strictEqual(stateManager.isBlameEnabled(uri2), false);
    });

    test("should clear all blame states (revert to default)", () => {
      const uri1 = Uri.file("/test/file1.ts");
      const uri2 = Uri.file("/test/file2.ts");

      stateManager.setBlameEnabled(uri1, false);
      stateManager.setBlameEnabled(uri2, false);

      stateManager.clearAll();

      assert.strictEqual(stateManager.isBlameEnabled(uri1), true);
      assert.strictEqual(stateManager.isBlameEnabled(uri2), true);
    });

    test("should get all enabled files", () => {
      const uri1 = Uri.file("/test/file1.ts");
      const uri2 = Uri.file("/test/file2.ts");

      stateManager.setBlameEnabled(uri1, true);
      stateManager.setBlameEnabled(uri2, true);

      const enabledFiles = stateManager.getEnabledFiles();
      assert.strictEqual(enabledFiles.length, 2);
    });
  });

  suite("autoBlame Default", () => {
    teardown(() => {
      vi.restoreAllMocks();
    });

    test("default follows autoBlame=false: blame off until explicitly enabled", () => {
      vi.spyOn(blameConfiguration, "isAutoBlameEnabled").mockReturnValue(false);
      assert.strictEqual(stateManager.isBlameEnabled(testUri), false);
      assert.strictEqual(stateManager.shouldShowBlame(testUri), false);
    });

    test("explicit enable overrides autoBlame=false", () => {
      vi.spyOn(blameConfiguration, "isAutoBlameEnabled").mockReturnValue(false);
      stateManager.setBlameEnabled(testUri, true);
      assert.strictEqual(stateManager.shouldShowBlame(testUri), true);
    });

    test("default follows autoBlame=true (default config)", () => {
      vi.spyOn(blameConfiguration, "isAutoBlameEnabled").mockReturnValue(true);
      assert.strictEqual(stateManager.isBlameEnabled(testUri), true);
    });
  });

  suite("Global State Override", () => {
    test("should respect global enabled state", () => {
      stateManager.setGlobalEnabled(false);
      stateManager.setBlameEnabled(testUri, true);

      // File is enabled, but global is disabled - shouldShowBlame accounts for both
      assert.strictEqual(stateManager.isBlameEnabled(testUri), true);
      assert.strictEqual(stateManager.shouldShowBlame(testUri), false);
    });

    test("should toggle global enabled state", () => {
      const initial = stateManager.isGlobalEnabled();
      stateManager.toggleGlobalEnabled();
      assert.strictEqual(stateManager.isGlobalEnabled(), !initial);
    });
  });
});
