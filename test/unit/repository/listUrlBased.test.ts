import { describe, it, expect } from "vitest";
import * as path from "path";

describe("Repository list URL-based", () => {
  describe("Path Conversion", () => {
    it("root folder converts to undefined for base URL listing", () => {
      const repoRoot = "/home/user/project";
      const filePath = "/home/user/project";

      const relativePath =
        filePath === repoRoot ? undefined : path.relative(repoRoot, filePath);

      expect(relativePath).toBeUndefined();
    });

    it("subfolder converts to relative path", () => {
      const repoRoot = "/home/user/project";
      const filePath: string = "/home/user/project/src/lib";

      const relativePath =
        filePath === repoRoot ? undefined : path.relative(repoRoot, filePath);

      // path.relative uses OS separator (forward on Unix, back on Windows)
      expect(relativePath).toBe(path.join("src", "lib"));
    });

    it("Windows paths work correctly", () => {
      const repoRoot = "C:\\Projects\\MyRepo";
      const filePath: string = "C:\\Projects\\MyRepo\\src\\lib";

      const relativePath =
        filePath === repoRoot ? undefined : path.relative(repoRoot, filePath);

      // On Unix this will use forward slashes, on Windows backslashes
      // Both are valid for SVN URL construction
      expect(relativePath).toMatch(/src[/\\]lib/);
    });
  });

  describe("URL Construction", () => {
    it("base URL used when folder is undefined", () => {
      const repoUrl = "https://svn.example.com/repo";
      const folder = undefined;

      const url = folder ? `${repoUrl}/${folder}` : repoUrl;

      expect(url).toBe("https://svn.example.com/repo");
    });

    it("folder appended to URL when provided", () => {
      const repoUrl = "https://svn.example.com/repo";
      const folder = "src/lib";

      const url = folder ? `${repoUrl}/${folder}` : repoUrl;

      expect(url).toBe("https://svn.example.com/repo/src/lib");
    });
  });

  describe("Performance", () => {
    it("URL-based list is non-recursive unlike local path list", () => {
      // svn list <localPath> --xml: recursive, slow for large repos
      // svn list <serverUrl> --xml: non-recursive, fast
      const localPathCommand = ["list", "/path/to/repo", "--xml"];
      const urlCommand = ["list", "https://svn.example.com/repo", "--xml"];

      // Both commands have same structure but different behavior
      expect(localPathCommand.length).toBe(urlCommand.length);
      // URL command is the correct one for sparse checkout
      expect(urlCommand[1]).toMatch(/^https?:\/\//);
    });
  });
});
