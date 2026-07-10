import { beforeEach, describe, expect, it, vi } from "vitest";
import { Uri, window } from "vscode";
import { Status } from "../../../src/common/types";
import { PullIncomingChange } from "../../../src/commands/pullIncomingChange";
import { configuration } from "../../../src/helpers/configuration";
import { Resource } from "../../../src/resource";

describe("PullIncomingChange notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(configuration, "get").mockReturnValue(true);
  });

  it("shows error message when all pulls fail", async () => {
    const command = new PullIncomingChange();
    const repository = {
      pullIncomingChange: vi.fn().mockRejectedValue(new Error("fail")),
      refreshRemoteChanges: vi.fn()
    };
    vi.spyOn(
      command as unknown as {
        runByRepositoryPaths: (
          uris: Uri[],
          fn: (repo: typeof repository, files: string[]) => Promise<void>
        ) => Promise<void>;
      },
      "runByRepositoryPaths"
    ).mockImplementation(async (_uris, fn) => {
      await fn(repository, ["/repo/a.txt", "/repo/b.txt"]);
    });

    await command.execute(
      new Resource(Uri.file("/repo/a.txt") as unknown as Uri, Status.MODIFIED),
      new Resource(Uri.file("/repo/b.txt") as unknown as Uri, Status.MODIFIED)
    );

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to update 2 files"
    );
    expect(repository.refreshRemoteChanges).toHaveBeenCalledTimes(1);
  });

  it("shows warning when some pulls fail", async () => {
    const command = new PullIncomingChange();
    const repository = {
      pullIncomingChange: vi.fn(async (filePath: string) => {
        if (filePath.endsWith("a.txt")) {
          return "Updated a";
        }
        throw new Error("fail");
      }),
      refreshRemoteChanges: vi.fn()
    };
    vi.spyOn(
      command as unknown as {
        runByRepositoryPaths: (
          uris: Uri[],
          fn: (repo: typeof repository, files: string[]) => Promise<void>
        ) => Promise<void>;
      },
      "runByRepositoryPaths"
    ).mockImplementation(async (_uris, fn) => {
      await fn(repository, ["/repo/a.txt", "/repo/b.txt"]);
    });

    await command.execute(
      new Resource(Uri.file("/repo/a.txt") as unknown as Uri, Status.MODIFIED),
      new Resource(Uri.file("/repo/b.txt") as unknown as Uri, Status.MODIFIED)
    );

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Updated 1 files, 1 failed"
    );
    expect(repository.refreshRemoteChanges).toHaveBeenCalledTimes(1);
  });

  it("shows detailed info for one successful pull", async () => {
    const command = new PullIncomingChange();
    const repository = {
      pullIncomingChange: vi.fn().mockResolvedValue("Updated trunk/file.txt"),
      refreshRemoteChanges: vi.fn()
    };
    vi.spyOn(
      command as unknown as {
        runByRepositoryPaths: (
          uris: Uri[],
          fn: (repo: typeof repository, files: string[]) => Promise<void>
        ) => Promise<void>;
      },
      "runByRepositoryPaths"
    ).mockImplementation(async (_uris, fn) => {
      await fn(repository, ["/repo/file.txt"]);
    });

    await command.execute(
      new Resource(
        Uri.file("/repo/file.txt") as unknown as Uri,
        Status.MODIFIED
      )
    );

    // Full success is SILENT: the incoming item visibly leaving the
    // remote-changes group is the feedback
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.setStatusBarMessage).not.toHaveBeenCalled();
    expect(repository.refreshRemoteChanges).toHaveBeenCalledTimes(1);
  });

  it("shows count info for multiple successful pulls", async () => {
    const command = new PullIncomingChange();
    const repository = {
      pullIncomingChange: vi
        .fn()
        .mockResolvedValueOnce("Updated a")
        .mockResolvedValueOnce("Updated b"),
      refreshRemoteChanges: vi.fn()
    };
    vi.spyOn(
      command as unknown as {
        runByRepositoryPaths: (
          uris: Uri[],
          fn: (repo: typeof repository, files: string[]) => Promise<void>
        ) => Promise<void>;
      },
      "runByRepositoryPaths"
    ).mockImplementation(async (_uris, fn) => {
      await fn(repository, ["/repo/a.txt", "/repo/b.txt"]);
    });

    await command.execute(
      new Resource(Uri.file("/repo/a.txt") as unknown as Uri, Status.MODIFIED),
      new Resource(Uri.file("/repo/b.txt") as unknown as Uri, Status.MODIFIED)
    );

    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.setStatusBarMessage).not.toHaveBeenCalled();
    expect(repository.refreshRemoteChanges).toHaveBeenCalledTimes(1);
  });

  it("suppresses notifications when showUpdateMessage is false", async () => {
    vi.spyOn(configuration, "get").mockReturnValue(false);
    const command = new PullIncomingChange();
    const repository = {
      pullIncomingChange: vi.fn().mockResolvedValue("Updated a"),
      refreshRemoteChanges: vi.fn()
    };
    vi.spyOn(
      command as unknown as {
        runByRepositoryPaths: (
          uris: Uri[],
          fn: (repo: typeof repository, files: string[]) => Promise<void>
        ) => Promise<void>;
      },
      "runByRepositoryPaths"
    ).mockImplementation(async (_uris, fn) => {
      await fn(repository, ["/repo/a.txt"]);
    });

    await command.execute(
      new Resource(Uri.file("/repo/a.txt") as unknown as Uri, Status.MODIFIED)
    );

    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.setStatusBarMessage).not.toHaveBeenCalled();
    expect(repository.refreshRemoteChanges).toHaveBeenCalledTimes(1);
  });
});
