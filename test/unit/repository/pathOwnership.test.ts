import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, window } from "vscode";
import { Repository } from "../../../src/repository";
import * as util from "../../../src/util";

function repositoryStub(overrides: Record<string, unknown>): Repository {
  return Object.assign(Object.create(Repository.prototype), overrides);
}

function privateMethod(
  name: string
): (this: Repository, arg: unknown) => unknown {
  return (Repository.prototype as unknown as Record<string, unknown>)[name] as (
    this: Repository,
    arg: unknown
  ) => unknown;
}

describe("Repository path ownership", () => {
  beforeEach(() => {
    vi.mocked(window.showInformationMessage).mockReset();
    vi.mocked(window.showWarningMessage).mockReset();
    vi.mocked(commands.executeCommand).mockClear();
  });

  it("ignores delete events from a lexical sibling", async () => {
    const wasFileTracked = vi.fn(async () => true);
    const removeFiles = vi.fn(async () => "removed");
    const repository = repositoryStub({
      repository: { workspaceRoot: "/workspace/repo" },
      getConfig: () => ({ actionForDeletedFiles: "remove" }),
      wasFileTracked,
      removeFiles
    });

    await privateMethod("onDidDeleteFiles").call(repository, {
      files: [{ fsPath: "/workspace/repository/file.txt" }]
    });

    expect(wasFileTracked).not.toHaveBeenCalled();
    expect(removeFiles).not.toHaveBeenCalled();
  });

  it("ignores lock prompts from a lexical sibling", async () => {
    const getResourceFromFile = vi.fn();
    const hasNeedsLock = vi.fn(async () => true);
    const repository = repositoryStub({
      repository: { workspaceRoot: "/workspace/repo" },
      lockPromptShown: new Set<string>(),
      getResourceFromFile,
      hasNeedsLock
    });

    await repository.promptLockIfNeeded({
      fsPath: "/workspace/repository/file.txt"
    } as never);

    expect(getResourceFromFile).not.toHaveBeenCalled();
    expect(hasNeedsLock).not.toHaveBeenCalled();
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("ignores update prompts from a lexical sibling", async () => {
    const hasRemoteChangeForFile = vi.fn(() => true);
    const repository = repositoryStub({
      repository: { workspaceRoot: "/workspace/repo" },
      hasRemoteChangeForFile
    });

    await privateMethod("promptUpdateIfRemoteChanges").call(repository, {
      fsPath: "/workspace/repository/file.txt"
    });

    expect(hasRemoteChangeForFile).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("keeps case-distinct edit prompt keys on case-sensitive platforms", async () => {
    const normalize = vi
      .spyOn(util, "normalizePath")
      .mockImplementation(file => file.replace(/[\\/]/g, "/"));
    try {
      const hasNeedsLock = vi.fn(async () => false);
      const repository = repositoryStub({
        repository: { workspaceRoot: "/workspace/repo" },
        lockEditPromptShown: new Set<string>(),
        lockPromptShown: new Set<string>(),
        getResourceFromFile: () => undefined,
        hasNeedsLock
      });

      await repository.promptLockOnEdit({
        fsPath: "/workspace/repo/A.ts"
      } as never);
      await repository.promptLockOnEdit({
        fsPath: "/workspace/repo/a.ts"
      } as never);

      expect(hasNeedsLock).toHaveBeenCalledTimes(2);
    } finally {
      normalize.mockRestore();
    }
  });
});
