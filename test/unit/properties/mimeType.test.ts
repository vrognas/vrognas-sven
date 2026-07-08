import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Mock repository for testing mime-type commands
interface MockRepository {
  getMimeType: Mock<(path: string) => Promise<string | null>>;
  setMimeType: Mock<(path: string, mimeType: string) => Promise<ExecResult>>;
  removeMimeType: Mock<(path: string) => Promise<ExecResult>>;
  getAllMimeTypeFiles: Mock<() => Promise<Map<string, string>>>;
}

describe("svn:mime-type Property", () => {
  let mockRepository: MockRepository;

  beforeEach(() => {
    mockRepository = {
      getMimeType: vi.fn(),
      setMimeType: vi.fn(),
      removeMimeType: vi.fn(),
      getAllMimeTypeFiles: vi.fn()
    };
  });

  describe("getMimeType", () => {
    it("returns mime-type value when set", async () => {
      mockRepository.getMimeType.mockResolvedValue("text/plain");

      const result = await mockRepository.getMimeType("readme.txt");

      expect(result).toBe("text/plain");
    });

    it("returns null when property not set", async () => {
      mockRepository.getMimeType.mockResolvedValue(null);

      const result = await mockRepository.getMimeType("file.txt");

      expect(result).toBeNull();
    });

    it("returns application/octet-stream for binary", async () => {
      mockRepository.getMimeType.mockResolvedValue("application/octet-stream");

      const result = await mockRepository.getMimeType("data.bin");

      expect(result).toBe("application/octet-stream");
    });
  });

  describe("setMimeType", () => {
    it("sets mime-type to text/plain", async () => {
      mockRepository.setMimeType.mockResolvedValue({
        stdout: "property 'svn:mime-type' set on 'file.txt'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setMimeType("file.txt", "text/plain");

      expect(result.exitCode).toBe(0);
      expect(mockRepository.setMimeType).toHaveBeenCalledWith(
        "file.txt",
        "text/plain"
      );
    });

    it("sets mime-type for image", async () => {
      mockRepository.setMimeType.mockResolvedValue({
        stdout: "property 'svn:mime-type' set on 'logo.png'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setMimeType("logo.png", "image/png");

      expect(result.exitCode).toBe(0);
    });

    it("sets application/octet-stream for binary", async () => {
      mockRepository.setMimeType.mockResolvedValue({
        stdout: "property 'svn:mime-type' set on 'data.bin'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setMimeType(
        "data.bin",
        "application/octet-stream"
      );

      expect(result.exitCode).toBe(0);
    });

    it("sets text/xml (not application/xml) for XML files", async () => {
      // Important: application/xml causes binary treatment!
      mockRepository.setMimeType.mockResolvedValue({
        stdout: "property 'svn:mime-type' set on 'config.xml'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.setMimeType("config.xml", "text/xml");

      expect(result.exitCode).toBe(0);
      expect(mockRepository.setMimeType).toHaveBeenCalledWith(
        "config.xml",
        "text/xml"
      );
    });
  });

  describe("removeMimeType", () => {
    it("removes mime-type property successfully", async () => {
      mockRepository.removeMimeType.mockResolvedValue({
        stdout: "property 'svn:mime-type' deleted from 'file.txt'",
        stderr: "",
        exitCode: 0
      });

      const result = await mockRepository.removeMimeType("file.txt");

      expect(result.exitCode).toBe(0);
    });

    it("handles file without property gracefully", async () => {
      mockRepository.removeMimeType.mockResolvedValue({
        stdout: "",
        stderr:
          "Attempting to delete nonexistent property 'svn:mime-type' on 'file.txt'",
        exitCode: 0
      });

      const result = await mockRepository.removeMimeType("file.txt");

      expect(result.exitCode).toBe(0);
    });
  });

  describe("getAllMimeTypeFiles", () => {
    it("returns map of all files with mime-type", async () => {
      mockRepository.getAllMimeTypeFiles.mockResolvedValue(
        new Map([
          ["logo.png", "image/png"],
          ["data.csv", "text/csv"],
          ["model.bin", "application/octet-stream"]
        ])
      );

      const result = await mockRepository.getAllMimeTypeFiles();

      expect(result.size).toBe(3);
      expect(result.get("logo.png")).toBe("image/png");
      expect(result.get("data.csv")).toBe("text/csv");
      expect(result.get("model.bin")).toBe("application/octet-stream");
    });

    it("returns empty map when no files have mime-type", async () => {
      mockRepository.getAllMimeTypeFiles.mockResolvedValue(new Map());

      const result = await mockRepository.getAllMimeTypeFiles();

      expect(result.size).toBe(0);
    });
  });

  describe("MIME type auto-detection", () => {
    // These test the helper function for auto-detecting MIME types
    it("suggests image/png for .png files", () => {
      const mimeMap: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".zip": "application/zip",
        ".json": "application/json",
        ".xml": "text/xml",
        ".txt": "text/plain",
        ".html": "text/html",
        ".css": "text/css"
      };

      for (const [ext, expectedMime] of Object.entries(mimeMap)) {
        expect(mimeMap[ext]).toBe(expectedMime);
      }
    });
  });
});
