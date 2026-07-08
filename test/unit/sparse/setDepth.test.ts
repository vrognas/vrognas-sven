import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { IExecutionResult, SvnDepth } from "../../../src/common/types";

interface MockRepository {
  setDepth: Mock<
    (
      folderPath: string,
      depth: keyof typeof SvnDepth,
      options?: { parents?: boolean; timeout?: number }
    ) => Promise<IExecutionResult>
  >;
}

describe("Sparse Checkout - setDepth", () => {
  let mockRepository: MockRepository;

  beforeEach(() => {
    mockRepository = {
      setDepth: vi.fn()
    };
  });

  describe("depth options", () => {
    it("excludes folder from working copy", async () => {
      mockRepository.setDepth.mockResolvedValue({
        stdout: "Updating 'data':\nAt revision 100.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setDepth("data", "exclude");

      expect(result.exitCode).toBe(0);
    });

    it("sets folder to empty depth (only directory)", async () => {
      mockRepository.setDepth.mockResolvedValue({
        stdout: "Updating 'data':\nAt revision 100.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setDepth("data", "empty");

      expect(result.exitCode).toBe(0);
    });

    it("sets folder to infinity depth (full recursion)", async () => {
      mockRepository.setDepth.mockResolvedValue({
        stdout:
          "Updating 'data':\nA    data/file1.csv\nA    data/file2.csv\nAt revision 100.",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setDepth("data", "infinity");

      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("handles non-existent path", async () => {
      mockRepository.setDepth.mockResolvedValue({
        stdout: "",
        stderr: "svn: E155007: 'nonexistent' is not a working copy",
        exitCode: 1
      });

      const result = await mockRepository.setDepth("nonexistent", "empty");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not a working copy");
    });
  });
});
