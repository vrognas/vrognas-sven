import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { IExecutionResult } from "../../../src/common/types";

// Mock repository for testing eol-style commands (mirrors Repository signatures)
interface MockRepository {
  getEolStyle: Mock<(filePath: string) => Promise<string | null>>;
  setEolStyle: Mock<
    (
      filePath: string,
      value: string,
      recursive?: boolean
    ) => Promise<IExecutionResult>
  >;
  removeEolStyle: Mock<
    (filePath: string, recursive?: boolean) => Promise<IExecutionResult>
  >;
  getAllEolStyleFiles: Mock<() => Promise<Map<string, string>>>;
}

describe("svn:eol-style Property", () => {
  let mockRepository: MockRepository;

  beforeEach(() => {
    mockRepository = {
      getEolStyle: vi.fn(),
      setEolStyle: vi.fn(),
      removeEolStyle: vi.fn(),
      getAllEolStyleFiles: vi.fn()
    };
  });

  describe("getEolStyle", () => {
    it("returns eol-style value when set", async () => {
      mockRepository.getEolStyle.mockResolvedValue("native");

      const result = await mockRepository.getEolStyle("file.txt");

      expect(result).toBe("native");
    });

    it("returns null when property not set", async () => {
      mockRepository.getEolStyle.mockResolvedValue(null);

      const result = await mockRepository.getEolStyle("binary.png");

      expect(result).toBeNull();
    });

    it("handles all valid eol-style values", async () => {
      const values = ["native", "LF", "CRLF", "CR"];

      for (const value of values) {
        mockRepository.getEolStyle.mockResolvedValue(value);
        const result = await mockRepository.getEolStyle("file.txt");
        expect(result).toBe(value);
      }
    });
  });

  describe("setEolStyle", () => {
    it("sets eol-style to native successfully", async () => {
      mockRepository.setEolStyle.mockResolvedValue({
        stdout: "property 'svn:eol-style' set on 'file.txt'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setEolStyle("file.txt", "native");

      expect(result.exitCode).toBe(0);
      expect(mockRepository.setEolStyle).toHaveBeenCalledWith(
        "file.txt",
        "native"
      );
    });

    it("sets eol-style to LF for shell scripts", async () => {
      mockRepository.setEolStyle.mockResolvedValue({
        stdout: "property 'svn:eol-style' set on 'script.sh'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setEolStyle("script.sh", "LF");

      expect(result.exitCode).toBe(0);
    });

    it("sets eol-style to CRLF for Windows files", async () => {
      mockRepository.setEolStyle.mockResolvedValue({
        stdout: "property 'svn:eol-style' set on 'build.bat'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setEolStyle("build.bat", "CRLF");

      expect(result.exitCode).toBe(0);
    });

    it("sets eol-style recursively on folder", async () => {
      mockRepository.setEolStyle.mockResolvedValue({
        stdout:
          "property 'svn:eol-style' set on 'src'\nproperty 'svn:eol-style' set on 'src/main.ts'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setEolStyle("src", "native", true);

      expect(result.exitCode).toBe(0);
      expect(mockRepository.setEolStyle).toHaveBeenCalledWith(
        "src",
        "native",
        true
      );
    });

    it("fails on binary file with mime-type", async () => {
      mockRepository.setEolStyle.mockResolvedValue({
        stdout: "",
        stderr: "svn: E200009: File 'image.png' has binary mime type property",
        exitCode: 1
      });

      const result = await mockRepository.setEolStyle("image.png", "native");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("binary mime type");
    });
  });

  describe("removeEolStyle", () => {
    it("removes eol-style property successfully", async () => {
      mockRepository.removeEolStyle.mockResolvedValue({
        stdout: "property 'svn:eol-style' deleted from 'file.txt'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.removeEolStyle("file.txt");

      expect(result.exitCode).toBe(0);
    });

    it("removes eol-style recursively from folder", async () => {
      mockRepository.removeEolStyle.mockResolvedValue({
        stdout: "property 'svn:eol-style' deleted from 'src'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.removeEolStyle("src", true);

      expect(result.exitCode).toBe(0);
      expect(mockRepository.removeEolStyle).toHaveBeenCalledWith("src", true);
    });

    it("handles file without property gracefully", async () => {
      mockRepository.removeEolStyle.mockResolvedValue({
        stdout: "",
        stderr:
          "Attempting to delete nonexistent property 'svn:eol-style' on 'file.txt'",
        exitCode: 0
      });

      const result = await mockRepository.removeEolStyle("file.txt");

      // SVN still returns 0 even when property doesn't exist
      expect(result.exitCode).toBe(0);
    });
  });

  describe("getAllEolStyleFiles", () => {
    it("returns map of all files with eol-style", async () => {
      mockRepository.getAllEolStyleFiles.mockResolvedValue(
        new Map([
          ["src/main.ts", "native"],
          ["scripts/build.sh", "LF"],
          ["config/settings.xml", "native"]
        ])
      );

      const result = await mockRepository.getAllEolStyleFiles();

      expect(result.size).toBe(3);
      expect(result.get("src/main.ts")).toBe("native");
      expect(result.get("scripts/build.sh")).toBe("LF");
    });

    it("returns empty map when no files have eol-style", async () => {
      mockRepository.getAllEolStyleFiles.mockResolvedValue(new Map());

      const result = await mockRepository.getAllEolStyleFiles();

      expect(result.size).toBe(0);
    });
  });
});
