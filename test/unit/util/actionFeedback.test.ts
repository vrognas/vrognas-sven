import { describe, it, expect, vi, beforeEach } from "vitest";
import { window } from "vscode";
import { showActionFeedback } from "../../../src/util/actionFeedback";
import { executeCommit } from "../../../src/helpers/commitHelper";
import { handleSvnResult } from "../../../src/util/lockHelpers";
import { Repository } from "../../../src/repository";

/**
 * Outcome confirmations of contextual actions render inline (status
 * bar) instead of as disconnected corner toasts. Notifications remain
 * for decisions, warnings/errors, and consequence-teaching messages.
 */

describe("inline action feedback", () => {
  beforeEach(() => {
    vi.mocked(window.setStatusBarMessage).mockClear();
    vi.mocked(window.showInformationMessage).mockClear();
    vi.mocked(window.showErrorMessage).mockClear();
  });

  it("shows in the status bar with a timeout, not as a toast", () => {
    showActionFeedback("Committed revision 42.");

    expect(vi.mocked(window.setStatusBarMessage)).toHaveBeenCalledWith(
      "Committed revision 42.",
      expect.any(Number)
    );
    expect(vi.mocked(window.showInformationMessage)).not.toHaveBeenCalled();
  });

  it("commit success is inline feedback", async () => {
    const repository = {
      inputBox: { value: "feat: x" },
      commitFiles: vi.fn(async () => "Committed revision 42."),
      staging: { clearOriginalChangelists: vi.fn() }
    };

    await executeCommit(repository as unknown as Repository, "feat: x", [
      "/ws/a.R"
    ]);

    expect(vi.mocked(window.setStatusBarMessage)).toHaveBeenCalledWith(
      "Committed revision 42.",
      expect.any(Number)
    );
    expect(vi.mocked(window.showInformationMessage)).not.toHaveBeenCalled();
  });

  it("lock/unlock success is inline; failures stay error toasts", () => {
    handleSvnResult(
      { exitCode: 0, stdout: "", stderr: "" } as never,
      "Locked 1 file",
      "Unable to lock"
    );
    expect(vi.mocked(window.setStatusBarMessage)).toHaveBeenCalledWith(
      "Locked 1 file",
      expect.any(Number)
    );

    handleSvnResult(
      { exitCode: 1, stdout: "", stderr: "E200035" } as never,
      "Locked 1 file",
      "Unable to lock"
    );
    expect(vi.mocked(window.showErrorMessage)).toHaveBeenCalled();
  });
});
