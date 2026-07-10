import { describe, it, expect, vi, beforeEach } from "vitest";
import { commands, window } from "vscode";
import { Repository } from "../../../src/repository";

/**
 * The "Update" action of the remote-changes prompt fired sven.update with
 * NO argument - in multi-root workspaces that popped a repository picker
 * (and picking wrong updated a different working copy) even though `this`
 * IS the owning repository.
 */

describe("promptUpdateIfRemoteChanges", () => {
  beforeEach(() => {
    vi.mocked(window.showWarningMessage).mockReset();
    vi.mocked(commands.executeCommand).mockClear();
  });

  it("passes the owning repository to sven.update", async () => {
    const mockThis = {
      workspaceRoot: "/ws",
      hasRemoteChangeForFile: () => true
    };
    vi.mocked(window.showWarningMessage).mockResolvedValue("Update" as never);
    const prompt = (Repository.prototype as unknown as Record<string, unknown>)
      .promptUpdateIfRemoteChanges as (
      this: unknown,
      uri: unknown
    ) => Promise<void>;

    await prompt.call(mockThis, { fsPath: "/ws/a.txt" });

    expect(vi.mocked(commands.executeCommand)).toHaveBeenCalledWith(
      "sven.update",
      mockThis
    );
  });
});
