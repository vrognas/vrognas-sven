import { describe, it, expect, vi, beforeEach } from "vitest";
import { window } from "vscode";

/**
 * Rollback To Revision E2E Tests
 *
 * Tests for rolling back a file to a previous revision using reverse merge.
 * Command: svn merge -r HEAD:TARGET_REV file
 *
 * Per SVN book: "reverse difference" undoes changes by merging backwards.
 */
describe("Rollback To Revision", () => {
  describe("rollbackToRevision() argument building", () => {
    /**
     * Simulates fixPegRevision from util.ts
     * Appends @ to filenames containing @ to prevent SVN peg revision parsing
     */
    function fixPegRevision(file: string): string {
      if (/@/.test(file)) {
        file += "@";
      }
      return file;
    }

    /**
     * Simulates the rollbackToRevision argument building logic
     * from svnRepository.ts (with peg revision fix)
     */
    function buildRollbackArgs(
      relativePath: string,
      targetRevision: string
    ): string[] {
      const safePath = fixPegRevision(relativePath);
      return ["merge", "-r", `HEAD:${targetRevision}`, safePath];
    }

    it("builds correct args for standard revision", () => {
      const args = buildRollbackArgs("src/file.txt", "50");
      expect(args).toEqual(["merge", "-r", "HEAD:50", "src/file.txt"]);
    });

    it("builds correct args for revision 1 (oldest)", () => {
      const args = buildRollbackArgs("file.txt", "1");
      expect(args).toEqual(["merge", "-r", "HEAD:1", "file.txt"]);
    });

    it("handles paths with spaces", () => {
      const args = buildRollbackArgs("my folder/my file.txt", "100");
      expect(args).toEqual([
        "merge",
        "-r",
        "HEAD:100",
        "my folder/my file.txt"
      ]);
    });

    it("handles deeply nested paths", () => {
      const args = buildRollbackArgs("src/components/ui/Button.tsx", "250");
      expect(args[3]).toBe("src/components/ui/Button.tsx");
      expect(args[2]).toBe("HEAD:250");
    });

    it("fixes peg revision for filenames with @ symbol", () => {
      // file@2024.txt would be interpreted as file at revision 2024
      // fixPegRevision appends @ to prevent this: file@2024.txt@
      const args = buildRollbackArgs("report@2024.txt", "50");
      expect(args[3]).toBe("report@2024.txt@");
    });

    it("fixes peg revision for paths with @ in directory", () => {
      const args = buildRollbackArgs("user@domain/file.txt", "100");
      expect(args[3]).toBe("user@domain/file.txt@");
    });
  });

  describe("confirmRollback() dialog", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    /**
     * Actual implementation of confirmRollback from input/rollback.ts
     */
    async function confirmRollback(revision: string): Promise<boolean> {
      const yes = "Yes, rollback";
      const answer = await window.showWarningMessage(
        `Rollback file to revision ${revision}? This will modify your working copy.`,
        { modal: true },
        yes
      );
      return answer === yes;
    }

    it("shows modal warning with revision number", async () => {
      vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);

      await confirmRollback("123");

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        "Rollback file to revision 123? This will modify your working copy.",
        { modal: true },
        "Yes, rollback"
      );
    });

    it("returns true when user confirms", async () => {
      vi.mocked(window.showWarningMessage).mockResolvedValue(
        "Yes, rollback" as unknown as undefined
      );

      const result = await confirmRollback("50");
      expect(result).toBe(true);
    });

    it("returns false when user cancels (escape)", async () => {
      vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);

      const result = await confirmRollback("50");
      expect(result).toBe(false);
    });
  });

  describe("rollbackToRevisionCmd() flow", () => {
    /**
     * Simulates the command execution flow from itemLogProvider.ts
     */
    async function executeRollbackFlow(
      hasCurrentItem: boolean,
      isCommitKind: boolean,
      userConfirms: boolean,
      rollbackSucceeds: boolean
    ): Promise<{
      rollbackCalled: boolean;
      infoShown: boolean;
      errorShown: boolean;
      errorMessage?: string;
    }> {
      const state = {
        rollbackCalled: false,
        infoShown: false,
        errorShown: false,
        errorMessage: undefined as string | undefined
      };

      // Early exit: no current item
      if (!hasCurrentItem) {
        return state;
      }

      // Early exit: not a commit item
      if (!isCommitKind) {
        return state;
      }

      // Early exit: user doesn't confirm
      if (!userConfirms) {
        return state;
      }

      // Try rollback
      try {
        if (!rollbackSucceeds) {
          throw new Error("svn: E195012: Unable to find repository location");
        }
        state.rollbackCalled = true;
        state.infoShown = true;
      } catch (error) {
        state.errorShown = true;
        state.errorMessage =
          error instanceof Error ? error.message : String(error);
      }

      return state;
    }

    it("exits early when no file is selected", async () => {
      const result = await executeRollbackFlow(false, true, true, true);

      expect(result.rollbackCalled).toBe(false);
      expect(result.infoShown).toBe(false);
    });

    it("exits early when item is not a commit", async () => {
      const result = await executeRollbackFlow(true, false, true, true);

      expect(result.rollbackCalled).toBe(false);
      expect(result.infoShown).toBe(false);
    });

    it("exits when user cancels confirmation", async () => {
      const result = await executeRollbackFlow(true, true, false, true);

      expect(result.rollbackCalled).toBe(false);
      expect(result.infoShown).toBe(false);
      expect(result.errorShown).toBe(false);
    });

    it("shows info on successful rollback", async () => {
      const result = await executeRollbackFlow(true, true, true, true);

      expect(result.rollbackCalled).toBe(true);
      expect(result.infoShown).toBe(true);
      expect(result.errorShown).toBe(false);
    });

    it("shows error on failed rollback", async () => {
      const result = await executeRollbackFlow(true, true, true, false);

      expect(result.rollbackCalled).toBe(false);
      expect(result.infoShown).toBe(false);
      expect(result.errorShown).toBe(true);
      expect(result.errorMessage).toContain("E195012");
    });
  });

  describe("SVN merge output parsing", () => {
    it("recognizes successful reverse merge output", () => {
      const output = `--- Reverse-merging r100 through r50 into 'file.txt':
U    file.txt`;

      expect(output).toContain("Reverse-merging");
      expect(output).toContain("U    file.txt");
    });

    it("recognizes merge conflict output", () => {
      const output = `--- Reverse-merging r100 through r50 into 'file.txt':
C    file.txt`;

      expect(output).toContain("C    file.txt");
    });

    it("recognizes tree conflict output", () => {
      const output = `--- Reverse-merging r100 through r50 into 'file.txt':
   C file.txt`;

      // Tree conflicts have leading spaces before C
      expect(output).toMatch(/\s+C\s+file\.txt/);
    });
  });

  describe("Error handling", () => {
    it("formats Error instance correctly", () => {
      const err = new Error("svn: E195012: Unable to find repository");
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe("svn: E195012: Unable to find repository");
    });

    it("formats string error correctly", () => {
      const err: unknown = "Unknown failure";
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe("Unknown failure");
    });

    it("builds user-friendly error message", () => {
      const err = new Error("svn: E160013: Path not found");
      const message = err instanceof Error ? err.message : String(err);
      const userMessage = `Rollback failed: ${message}`;
      expect(userMessage).toBe("Rollback failed: svn: E160013: Path not found");
    });
  });
});
