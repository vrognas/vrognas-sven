import * as assert from "assert";
import { commands, window } from "vscode";
import { Update } from "../../../commands/update";
import { Repository } from "../../../repository";
import { configuration } from "../../../helpers/configuration";
import { IUpdateResult } from "../../../common/types";

// Helper to create IUpdateResult
function makeResult(
  message: string,
  revision: number | null = 123,
  conflicts: string[] = []
): IUpdateResult {
  return { message, revision, conflicts };
}

suite("Update Command Tests", () => {
  let update: Update;
  let mockRepository: Partial<Repository>;
  let origShowWarning: typeof window.showWarningMessage;
  let origShowError: typeof window.showErrorMessage;
  let origWithProgress: typeof window.withProgress;
  let origConfigGet: typeof configuration.get;
  let origExecuteCommand: typeof commands.executeCommand;

  // Call tracking
  let showInfoCalls: any[] = [];
  let showWarningCalls: any[] = [];
  let showErrorCalls: any[] = [];
  let updateRevisionCalls: any[] = [];
  let configGetCalls: any[] = [];

  setup(() => {
    update = new Update();

    // Mock Repository - now returns IUpdateResult. Success feedback
    // flashes INSIDE the sync status bar item (statusBar.flashSyncResult)
    mockRepository = {
      updateRevision: async (ignoreExternals: boolean) => {
        updateRevisionCalls.push({ ignoreExternals });
        return makeResult("Updated to revision 123.", 123);
      },
      statusBar: {
        flashSyncResult: (message: string) => {
          showInfoCalls.push({ message });
        }
      } as never
    };

    // Mock window.withProgress to execute immediately
    origWithProgress = window.withProgress;
    (window as any).withProgress = async (_opts: any, task: any) => {
      return task();
    };

    // Mock window.showWarningMessage
    origShowWarning = window.showWarningMessage;
    (window as any).showWarningMessage = (
      message: string,
      ...buttons: any[]
    ) => {
      showWarningCalls.push({ message, buttons });
      return Promise.resolve(undefined);
    };

    // Mock window.showErrorMessage
    origShowError = window.showErrorMessage;
    (window as any).showErrorMessage = (message: string) => {
      showErrorCalls.push({ message });
      return Promise.resolve(undefined);
    };

    // Mock commands.executeCommand
    origExecuteCommand = commands.executeCommand;
    (commands as any).executeCommand = async () => {};

    // Mock configuration.get
    origConfigGet = configuration.get;
    (configuration as any).get = (key: string, defaultValue?: any) => {
      configGetCalls.push({ key, defaultValue });
      if (key === "update.ignoreExternals") return false;
      if (key === "showUpdateMessage") return true;
      return defaultValue;
    };

    // Clear call tracking
    showInfoCalls = [];
    showWarningCalls = [];
    showErrorCalls = [];
    updateRevisionCalls = [];
    configGetCalls = [];
  });

  teardown(() => {
    update.dispose();
    (window as any).showWarningMessage = origShowWarning;
    (window as any).showErrorMessage = origShowError;
    (window as any).withProgress = origWithProgress;
    (commands as any).executeCommand = origExecuteCommand;
    (configuration as any).get = origConfigGet;
  });

  suite("Basic Update", () => {
    test("should update repository with default config", async () => {
      await update.execute(mockRepository as Repository);

      assert.strictEqual(updateRevisionCalls.length, 1);
      assert.strictEqual(updateRevisionCalls[0].ignoreExternals, false);
      assert.strictEqual(showInfoCalls.length, 1);
      assert.strictEqual(showInfoCalls[0].message, "Updated to revision 123.");
    });

    test("should call updateRevision on repository", async () => {
      await update.execute(mockRepository as Repository);

      assert.strictEqual(updateRevisionCalls.length, 1);
      assert.ok(typeof updateRevisionCalls[0].ignoreExternals === "boolean");
    });

    test("should display success message", async () => {
      await update.execute(mockRepository as Repository);

      assert.strictEqual(showInfoCalls.length, 1);
      assert.ok(showInfoCalls[0].message.includes("Updated to revision"));
    });

    test("should read configuration values", async () => {
      await update.execute(mockRepository as Repository);

      const ignoreExternalsCall = configGetCalls.find(
        c => c.key === "update.ignoreExternals"
      );
      const showMessageCall = configGetCalls.find(
        c => c.key === "showUpdateMessage"
      );

      assert.ok(ignoreExternalsCall, "Should read update.ignoreExternals");
      assert.ok(showMessageCall, "Should read showUpdateMessage");
    });
  });

  suite("Conflict Detection", () => {
    test("should show warning for single conflict", async () => {
      mockRepository.updateRevision = async () =>
        makeResult("Updated to revision 100.", 100, ["src/file.ts"]);

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showWarningCalls.length, 1);
      assert.ok(showWarningCalls[0].message.includes("Conflict"));
      assert.ok(showWarningCalls[0].message.includes("src/file.ts"));
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("should show warning for multiple conflicts", async () => {
      mockRepository.updateRevision = async () =>
        makeResult("Updated to revision 100.", 100, ["a.ts", "b.ts", "c.ts"]);

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showWarningCalls.length, 1);
      assert.ok(showWarningCalls[0].message.includes("3 conflicts"));
    });

    test("should include action buttons for conflicts", async () => {
      mockRepository.updateRevision = async () =>
        makeResult("Updated to revision 100.", 100, ["file.ts"]);

      await update.execute(mockRepository as Repository);

      assert.ok(showWarningCalls[0].buttons.includes("Resolve Conflicts"));
      assert.ok(showWarningCalls[0].buttons.includes("View SCM"));
    });
  });

  suite("Ignore Externals Config", () => {
    test("should ignore externals when config is true", async () => {
      (configuration as any).get = (key: string, defaultValue?: any) => {
        configGetCalls.push({ key, defaultValue });
        if (key === "update.ignoreExternals") return true;
        if (key === "showUpdateMessage") return true;
        return defaultValue;
      };

      await update.execute(mockRepository as Repository);

      assert.strictEqual(updateRevisionCalls.length, 1);
      assert.strictEqual(updateRevisionCalls[0].ignoreExternals, true);
    });

    test("should not ignore externals when config is false", async () => {
      (configuration as any).get = (key: string, defaultValue?: any) => {
        configGetCalls.push({ key, defaultValue });
        if (key === "update.ignoreExternals") return false;
        if (key === "showUpdateMessage") return true;
        return defaultValue;
      };

      await update.execute(mockRepository as Repository);

      assert.strictEqual(updateRevisionCalls.length, 1);
      assert.strictEqual(updateRevisionCalls[0].ignoreExternals, false);
    });
  });

  suite("Show Update Message Config", () => {
    test("should show message when config is true", async () => {
      (configuration as any).get = (key: string, defaultValue?: any) => {
        configGetCalls.push({ key, defaultValue });
        if (key === "update.ignoreExternals") return false;
        if (key === "showUpdateMessage") return true;
        return defaultValue;
      };

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showInfoCalls.length, 1);
      assert.strictEqual(showInfoCalls[0].message, "Updated to revision 123.");
    });

    test("should not show message when config is false", async () => {
      (configuration as any).get = (key: string, defaultValue?: any) => {
        configGetCalls.push({ key, defaultValue });
        if (key === "update.ignoreExternals") return false;
        if (key === "showUpdateMessage") return false;
        return defaultValue;
      };

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showInfoCalls.length, 0);
      assert.strictEqual(updateRevisionCalls.length, 1);
    });
  });

  suite("Error Handling", () => {
    test("should handle update failure", async () => {
      mockRepository.updateRevision = async () => {
        throw new Error("svn: E155004: Working copy locked");
      };

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showErrorCalls.length, 1);
      assert.ok(showErrorCalls[0].message.includes("E155004"));
      assert.ok(showErrorCalls[0].message.includes("cleanup"));
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("should handle network error", async () => {
      mockRepository.updateRevision = async () => {
        throw new Error("svn: E170013: Unable to connect to repository");
      };

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showErrorCalls.length, 1);
      assert.ok(showErrorCalls[0].message.includes("E170013"));
      assert.ok(showErrorCalls[0].message.includes("Unable to connect"));
    });
  });

  suite("Null Revision Handling", () => {
    test("should show generic message when revision is null", async () => {
      mockRepository.updateRevision = async () => makeResult("", null, []);

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showInfoCalls.length, 1);
      assert.strictEqual(showInfoCalls[0].message, "Update completed");
    });
  });

  suite("Update Messages", () => {
    test("should display revision number in message", async () => {
      mockRepository.updateRevision = async () =>
        makeResult("Updated to revision 456.", 456);

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showInfoCalls.length, 1);
      assert.ok(showInfoCalls[0].message.includes("456"));
    });

    test("should display 'At revision' message", async () => {
      mockRepository.updateRevision = async () =>
        makeResult("At revision 789.", 789);

      await update.execute(mockRepository as Repository);

      assert.strictEqual(showInfoCalls.length, 1);
      assert.strictEqual(showInfoCalls[0].message, "At revision 789.");
    });
  });

  suite("Multiple Sequential Updates", () => {
    test("should handle multiple update calls", async () => {
      await update.execute(mockRepository as Repository);
      await update.execute(mockRepository as Repository);
      await update.execute(mockRepository as Repository);

      assert.strictEqual(updateRevisionCalls.length, 3);
      assert.strictEqual(showInfoCalls.length, 3);
    });

    test("should handle update after error", async () => {
      mockRepository.updateRevision = async () => {
        throw new Error("First update failed");
      };

      await update.execute(mockRepository as Repository);
      assert.strictEqual(showErrorCalls.length, 1);

      // Reset mock to succeed
      mockRepository.updateRevision = async () => {
        updateRevisionCalls.push({ ignoreExternals: false });
        return makeResult("Updated to revision 500.", 500);
      };
      updateRevisionCalls = [];
      showErrorCalls = [];
      showInfoCalls = [];

      await update.execute(mockRepository as Repository);

      assert.strictEqual(updateRevisionCalls.length, 1);
      assert.strictEqual(showInfoCalls.length, 1);
      assert.strictEqual(showErrorCalls.length, 0);
    });
  });
});
