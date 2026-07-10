import * as assert from "assert";
import { window } from "vscode";
import { vi } from "vitest";
import { Cleanup } from "../../../commands/cleanup";
import { Upgrade } from "../../../commands/upgrade";
import { Repository } from "../../../repository";
import { configuration } from "../../../helpers/configuration";

function normalizePathForAssert(value: string): string {
  return value.replace(/\\/g, "/");
}

suite("Cleanup and Upgrade Commands Tests", () => {
  setup(() => {
    vi.restoreAllMocks();
  });

  test("Cleanup exits when user cancels picker", async () => {
    const command = new Cleanup();
    const cleanupAdvanced = vi.fn();
    const repository = { cleanupAdvanced } as unknown as Repository;

    vi.spyOn(window, "showQuickPick").mockResolvedValue(undefined);

    await command.execute(repository);

    assert.strictEqual(cleanupAdvanced.mock.calls.length, 0);
    command.dispose();
  });

  test("Cleanup runs basic cleanup and shows completion message", async () => {
    const command = new Cleanup();
    const cleanupAdvanced = vi.fn().mockResolvedValue(undefined);
    const repository = { cleanupAdvanced } as unknown as Repository;

    vi.spyOn(window, "showQuickPick").mockImplementation(async () => [] as any);
    vi.spyOn(window, "withProgress").mockImplementation(
      async (_o: any, task: any) => {
        return task();
      }
    );
    // Completion is inline status-bar feedback, not a toast
    const feedbackSpy = vi
      .spyOn(window, "setStatusBarMessage")
      .mockReturnValue({ dispose() {} } as any);

    await command.execute(repository);

    assert.strictEqual(cleanupAdvanced.mock.calls.length, 1);
    assert.deepStrictEqual(cleanupAdvanced.mock.calls[0]![0], {});
    assert.ok(feedbackSpy.mock.calls.length > 0);
    assert.ok(
      String(feedbackSpy.mock.calls[0]![0]).includes("Cleanup completed")
    );
    command.dispose();
  });

  test("Upgrade performs upgrade flow on Yes", async () => {
    const command = new Upgrade();
    const manager = {
      upgradeWorkingCopy: vi.fn().mockResolvedValue(true),
      tryOpenRepository: vi.fn()
    };

    vi.spyOn(configuration, "get").mockReturnValue(false as any);
    vi.spyOn(window, "showWarningMessage").mockResolvedValue("Yes" as any);
    // Upgrade success is inline status-bar feedback, not a toast
    const feedbackSpy = vi
      .spyOn(window, "setStatusBarMessage")
      .mockReturnValue({ dispose() {} } as any);
    (command as any).getSourceControlManager = async () => manager;

    await command.execute("/test/path");

    assert.strictEqual(manager.upgradeWorkingCopy.mock.calls.length, 1);
    assert.strictEqual(
      normalizePathForAssert(manager.upgradeWorkingCopy.mock.calls[0]![0]),
      "/test/path"
    );
    assert.strictEqual(manager.tryOpenRepository.mock.calls.length, 1);
    assert.ok(feedbackSpy.mock.calls.length > 0);
    command.dispose();
  });

  test("Upgrade shows error when upgrade fails", async () => {
    const command = new Upgrade();
    const manager = {
      upgradeWorkingCopy: vi.fn().mockResolvedValue(false),
      tryOpenRepository: vi.fn()
    };

    vi.spyOn(configuration, "get").mockReturnValue(false as any);
    vi.spyOn(window, "showWarningMessage").mockResolvedValue("Yes" as any);
    const errorSpy = vi
      .spyOn(window, "showErrorMessage")
      .mockResolvedValue(undefined);
    (command as any).getSourceControlManager = async () => manager;

    await command.execute("/test/path");

    assert.strictEqual(manager.upgradeWorkingCopy.mock.calls.length, 1);
    assert.strictEqual(manager.tryOpenRepository.mock.calls.length, 0);
    assert.ok(errorSpy.mock.calls.length > 0);
    assert.ok(
      String(errorSpy.mock.calls[0]![0]).includes("Error on upgrading")
    );
    command.dispose();
  });

  test("Upgrade saves ignore flag on Don't Show Again", async () => {
    const command = new Upgrade();
    const manager = {
      upgradeWorkingCopy: vi.fn(),
      tryOpenRepository: vi.fn()
    };

    vi.spyOn(configuration, "get").mockReturnValue(false as any);
    const updateSpy = vi
      .spyOn(configuration, "update")
      .mockResolvedValue(undefined);
    vi.spyOn(window, "showWarningMessage").mockResolvedValue(
      "Don't Show Again" as any
    );
    (command as any).getSourceControlManager = async () => manager;

    await command.execute("/test/path");

    assert.strictEqual(updateSpy.mock.calls.length, 1);
    assert.strictEqual(
      updateSpy.mock.calls[0]![0],
      "ignoreWorkingCopyIsTooOld"
    );
    assert.strictEqual(updateSpy.mock.calls[0]![1], true);
    command.dispose();
  });

  test("Upgrade exits early when ignore config is enabled", async () => {
    const command = new Upgrade();
    vi.spyOn(configuration, "get").mockReturnValue(true as any);
    const getScmSpy = vi
      .spyOn(command as any, "getSourceControlManager")
      .mockResolvedValue({});

    await command.execute("/test/path");

    assert.strictEqual(getScmSpy.mock.calls.length, 0);
    command.dispose();
  });
});
