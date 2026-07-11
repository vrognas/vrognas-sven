import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window } from "vscode";
import {
  showActionFeedback,
  showCommitBoxFeedback,
  showViewFeedback
} from "../../../src/util/actionFeedback";
import { executeCommit } from "../../../src/helpers/commitHelper";
import { handleSvnResult } from "../../../src/util/lockHelpers";
import { Repository } from "../../../src/repository";

/**
 * Outcome confirmations render WHERE the action took place: the tree
 * view for view actions, the commit box for commits, the status bar
 * only when there is no surface to anchor to. Toast notifications
 * remain for decisions, warnings/errors, and teaching messages.
 */

describe("inline action feedback", () => {
  beforeEach(() => {
    vi.mocked(window.setStatusBarMessage).mockClear();
    vi.mocked(window.showInformationMessage).mockClear();
    vi.mocked(window.showErrorMessage).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-locus feedback goes to the status bar with a timeout, not a toast", () => {
    showActionFeedback("Copied r42 to clipboard");

    expect(vi.mocked(window.setStatusBarMessage)).toHaveBeenCalledWith(
      "Copied r42 to clipboard",
      expect.any(Number)
    );
    expect(vi.mocked(window.showInformationMessage)).not.toHaveBeenCalled();
  });

  it("view feedback renders INSIDE the view and auto-clears", () => {
    vi.useFakeTimers();
    const view: { message?: string; visible?: boolean } = { visible: true };

    showViewFeedback(
      view,
      "Revision 401 not found in this repository's history."
    );

    expect(view.message).toBe(
      "Revision 401 not found in this repository's history."
    );
    vi.runAllTimers();
    expect(view.message).toBeUndefined();
  });

  it("falls back to the status bar when the view is HIDDEN", () => {
    // e.g. goToRevision invoked from a blame hover while Repo History
    // is collapsed - a message inside it would be invisible
    const view: { message?: string; visible?: boolean } = { visible: false };

    showViewFeedback(view, "Revision 401 not found.");

    expect(view.message).toBeUndefined();
    expect(vi.mocked(window.setStatusBarMessage)).toHaveBeenCalledWith(
      "Revision 401 not found.",
      expect.any(Number)
    );
  });

  it("commit-box feedback flashes the placeholder and restores it", () => {
    vi.useFakeTimers();
    const inputBox = {
      value: "",
      placeholder: "Message (Ctrl+Enter to commit)"
    };

    showCommitBoxFeedback(inputBox, "Committed revision 42.");

    expect(inputBox.placeholder).toBe("Committed revision 42.");
    vi.runAllTimers();
    expect(inputBox.placeholder).toBe("Message (Ctrl+Enter to commit)");
  });

  it("commit success lands in the commit box", async () => {
    vi.useFakeTimers();
    const repository = {
      inputBox: { value: "feat: x", placeholder: "Message" },
      commitFiles: vi.fn(async () => "Committed revision 42."),
      staging: { clearOriginalChangelists: vi.fn() }
    };

    await executeCommit(repository as unknown as Repository, "feat: x", [
      "/ws/a.R"
    ]);

    expect(repository.inputBox.value).toBe("");
    expect(repository.inputBox.placeholder).toBe("Committed revision 42.");
    // ...and in the status bar, which is visible even when the SCM view
    // is closed (palette/keybinding commits)
    expect(vi.mocked(window.setStatusBarMessage)).toHaveBeenCalledWith(
      "Committed revision 42.",
      expect.any(Number)
    );
    expect(vi.mocked(window.showInformationMessage)).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(repository.inputBox.placeholder).toBe("Message");
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
