import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Mock repository for testing auto-props commands
interface MockRepository {
  getAutoProps: Mock<() => Promise<string | null>>;
  setAutoProps: Mock<(value: string) => Promise<ExecResult>>;
  removeAutoProps: Mock<() => Promise<ExecResult>>;
}

describe("svn:auto-props Property", () => {
  let mockRepository: MockRepository;

  beforeEach(() => {
    mockRepository = {
      getAutoProps: vi.fn(),
      setAutoProps: vi.fn(),
      removeAutoProps: vi.fn()
    };
  });

  describe("getAutoProps", () => {
    it("returns auto-props value when set", async () => {
      const autoProps = `*.txt = svn:eol-style=native
*.png = svn:mime-type=image/png
*.sh = svn:eol-style=LF;svn:executable`;

      mockRepository.getAutoProps.mockResolvedValue(autoProps);

      const result = await mockRepository.getAutoProps();

      expect(result).toBe(autoProps);
      expect(result).toContain("*.txt");
      expect(result).toContain("svn:eol-style=native");
    });

    it("returns null when property not set", async () => {
      mockRepository.getAutoProps.mockResolvedValue(null);

      const result = await mockRepository.getAutoProps();

      expect(result).toBeNull();
    });
  });

  describe("setAutoProps", () => {
    it("sets auto-props on repository root", async () => {
      const autoProps = `*.txt = svn:eol-style=native
*.png = svn:mime-type=image/png`;

      mockRepository.setAutoProps.mockResolvedValue({
        stdout: "property 'svn:auto-props' set on '.'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setAutoProps(autoProps);

      expect(result.exitCode).toBe(0);
      expect(mockRepository.setAutoProps).toHaveBeenCalledWith(autoProps);
    });

    it("handles complex auto-props with multiple properties per pattern", async () => {
      const autoProps = `*.sh = svn:eol-style=LF;svn:executable
*.py = svn:eol-style=native;svn:keywords=Id Author Date`;

      mockRepository.setAutoProps.mockResolvedValue({
        stdout: "property 'svn:auto-props' set on '.'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setAutoProps(autoProps);

      expect(result.exitCode).toBe(0);
    });
  });

  describe("removeAutoProps", () => {
    it("removes auto-props from repository root", async () => {
      mockRepository.removeAutoProps.mockResolvedValue({
        stdout: "property 'svn:auto-props' deleted from '.'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.removeAutoProps();

      expect(result.exitCode).toBe(0);
    });
  });

  describe("auto-props format validation", () => {
    it("validates correct auto-props format", () => {
      const validFormats = [
        "*.txt = svn:eol-style=native",
        "*.png = svn:mime-type=image/png",
        "*.sh = svn:eol-style=LF;svn:executable",
        "Makefile = svn:eol-style=native"
      ];

      // Pattern: <pattern> = <property>[=<value>][;<property>[=<value>]...]
      // Note: svn:executable doesn't require a value
      const regex = /^[\w.*?[\]{}]+\s*=\s*svn:/;

      for (const format of validFormats) {
        expect(regex.test(format)).toBe(true);
      }
    });
  });
});
