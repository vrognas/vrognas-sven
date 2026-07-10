import { describe, it, expect, vi, beforeEach } from "vitest";
import { commands, Uri, window } from "vscode";
import { Command } from "../../../src/commands/command";

/**
 * Error-recovery "Steal Lock"/"Lock File" used to fire the command with
 * NO arguments, so it fell back to the ACTIVE EDITOR - stealing the lock
 * of whatever file happened to be open, not the file that blocked the
 * failed operation.
 */

const uri = Uri.file("/ws/data.csv");

function makeThis() {
  // Command isn't unit-constructible; its error-handling helpers live on
  // the prototype and carry no constructor state
  return Object.create(Command.prototype) as {
    handleOperationError: (
      error: unknown,
      errorMsg: string,
      targets?: Uri[]
    ) => Promise<void>;
  };
}

describe("handleOperationError lock actions target the failed file", () => {
  beforeEach(() => {
    vi.mocked(window.showErrorMessage).mockReset();
    vi.mocked(commands.executeCommand).mockClear();
  });

  it("Steal Lock receives the failed file's uri", async () => {
    vi.mocked(window.showErrorMessage).mockResolvedValue("Steal Lock" as never);

    await makeThis().handleOperationError(
      new Error(
        "svn: E200035: Path '/ws/data.csv' is already locked by user 'alice'"
      ),
      "Unable to commit",
      [uri]
    );

    expect(vi.mocked(commands.executeCommand)).toHaveBeenCalledWith(
      "sven.stealLock",
      uri
    );
  });

  it("Lock File receives the failed file's uri", async () => {
    vi.mocked(window.showErrorMessage).mockResolvedValue("Lock File" as never);

    await makeThis().handleOperationError(
      new Error("svn: E200036: Path '/ws/data.csv' is not locked"),
      "Unable to commit",
      [uri]
    );

    expect(vi.mocked(commands.executeCommand)).toHaveBeenCalledWith(
      "sven.lock",
      uri
    );
  });
});
