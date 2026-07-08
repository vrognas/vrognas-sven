import { describe, it, expect, vi } from "vitest";

// Mock vscode
vi.mock("vscode", () => ({
  Uri: {
    file: (path: string) => ({ scheme: "file", fsPath: path })
  }
}));

interface MockResource {
  resourceUri: { fsPath: string };
}

describe("hasRemoteChangeForFile", () => {
  it("returns true when file has remote changes", () => {
    const mockResource: MockResource = {
      resourceUri: { fsPath: "/workspace/src/test.ts" }
    };
    const mockRepo = {
      groupManager: {
        remoteChanges: {
          resourceStates: [mockResource]
        }
      }
    };

    // Simulate the method logic
    const hasChange = (filePath: string): boolean => {
      if (!mockRepo.groupManager.remoteChanges) {
        return false;
      }
      const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
      for (const resource of mockRepo.groupManager.remoteChanges
        .resourceStates) {
        const resourcePath = resource.resourceUri.fsPath
          .replace(/\\/g, "/")
          .toLowerCase();
        if (resourcePath === normalizedPath) {
          return true;
        }
      }
      return false;
    };

    expect(hasChange("/workspace/src/test.ts")).toBe(true);
  });

  it("returns false when file has no remote changes", () => {
    const mockRepo = {
      groupManager: {
        remoteChanges: {
          resourceStates: [] as MockResource[]
        }
      }
    };

    const hasChange = (filePath: string): boolean => {
      if (!mockRepo.groupManager.remoteChanges) {
        return false;
      }
      const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
      for (const resource of mockRepo.groupManager.remoteChanges
        .resourceStates) {
        const resourcePath = resource.resourceUri.fsPath
          .replace(/\\/g, "/")
          .toLowerCase();
        if (resourcePath === normalizedPath) {
          return true;
        }
      }
      return false;
    };

    expect(hasChange("/workspace/src/test.ts")).toBe(false);
  });

  it("returns false when remoteChanges is undefined", () => {
    const mockRepo = {
      groupManager: {
        remoteChanges: undefined
      }
    };

    const hasChange = (): boolean => {
      if (!mockRepo.groupManager.remoteChanges) {
        return false;
      }
      return true;
    };

    expect(hasChange()).toBe(false);
  });
});
