import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type {
  IExecutionResult,
  ILockOptions,
  ISvnLockInfo,
  IUnlockOptions
} from "../../../src/common/types";

// Mock repository for testing lock commands, typed to match Repository signatures
interface MockRepository {
  lock: Mock<
    (files: string[], options?: ILockOptions) => Promise<IExecutionResult>
  >;
  unlock: Mock<
    (files: string[], options?: IUnlockOptions) => Promise<IExecutionResult>
  >;
  getLockInfo: Mock<(filePath: string) => Promise<ISvnLockInfo | null>>;
}

describe("Lock Commands", () => {
  let mockRepository: MockRepository;

  beforeEach(() => {
    mockRepository = {
      lock: vi.fn(),
      unlock: vi.fn(),
      getLockInfo: vi.fn()
    };
  });

  describe("svn lock", () => {
    it("locks a file successfully", async () => {
      mockRepository.lock.mockResolvedValue({
        stdout: "'data.csv' locked by user 'alice'.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.lock(["data.csv"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("locked");
    });

    it("locks a file with comment", async () => {
      mockRepository.lock.mockResolvedValue({
        stdout: "'data.csv' locked by user 'alice'.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.lock(["data.csv"], {
        comment: "Editing dataset"
      });

      expect(result.exitCode).toBe(0);
    });

    it("locks multiple files at once", async () => {
      mockRepository.lock.mockResolvedValue({
        stdout:
          "'file1.csv' locked by user 'alice'.\n'file2.csv' locked by user 'alice'.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.lock(["file1.csv", "file2.csv"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file1.csv");
      expect(result.stdout).toContain("file2.csv");
    });

    it("locks a directory", async () => {
      mockRepository.lock.mockResolvedValue({
        stdout: "'data/' locked by user 'alice'.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.lock(["data/"]);

      expect(result.exitCode).toBe(0);
    });

    it("fails when file already locked by another user", async () => {
      mockRepository.lock.mockResolvedValue({
        stdout: "",
        stderr:
          "svn: E160042: Lock failed: path '/repo/data.csv' is already locked by user 'bob'",
        exitCode: 1
      });

      const result = await mockRepository.lock(["data.csv"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("already locked");
    });
  });

  describe("svn unlock", () => {
    it("unlocks a file successfully", async () => {
      mockRepository.unlock.mockResolvedValue({
        stdout: "'data.csv' unlocked.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.unlock(["data.csv"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("unlocked");
    });

    it("force unlocks (breaks lock) another user's lock", async () => {
      mockRepository.unlock.mockResolvedValue({
        stdout: "'data.csv' unlocked.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.unlock(["data.csv"], { force: true });

      expect(result.exitCode).toBe(0);
    });

    it("fails to unlock file locked by another without --force", async () => {
      mockRepository.unlock.mockResolvedValue({
        stdout: "",
        stderr:
          "svn: E195013: No lock on path '/home/user/project/data.csv' (status: 403)",
        exitCode: 1
      });

      const result = await mockRepository.unlock(["data.csv"]);

      expect(result.exitCode).toBe(1);
    });

    it("unlocks multiple files at once", async () => {
      mockRepository.unlock.mockResolvedValue({
        stdout: "'file1.csv' unlocked.\n'file2.csv' unlocked.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.unlock(["file1.csv", "file2.csv"]);

      expect(result.exitCode).toBe(0);
    });
  });

  describe("getLockInfo", () => {
    it("returns lock info for locked file", async () => {
      mockRepository.getLockInfo.mockResolvedValue({
        owner: "alice",
        token: "opaquelocktoken:12345",
        comment: "Working on it",
        created: "2025-11-28T10:00:00.000000Z"
      });

      const result = await mockRepository.getLockInfo("data.csv");

      expect(result).toBeTruthy();
      expect(result?.owner).toBe("alice");
    });

    it("returns null for unlocked file", async () => {
      mockRepository.getLockInfo.mockResolvedValue(null);

      const result = await mockRepository.getLockInfo("readme.txt");

      expect(result).toBeNull();
    });
  });
});
