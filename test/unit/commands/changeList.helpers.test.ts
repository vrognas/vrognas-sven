import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { Uri, window } from "vscode";
import { Status } from "../../../src/common/types";
import * as changelistItems from "../../../src/changelistItems";
import { ChangeList } from "../../../src/commands/changeList";
import { Repository } from "../../../src/repository";
import { Resource } from "../../../src/resource";
import { SourceControlManager } from "../../../src/source_control_manager";

class TestChangeList extends ChangeList {
  constructor(
    private readonly getRepositoryFromUriImpl: (uri: Uri) => Repository | null
  ) {
    super();
  }

  protected async getSourceControlManager(): Promise<SourceControlManager> {
    const partial: Partial<SourceControlManager> = {
      getRepositoryFromUri: this.getRepositoryFromUriImpl
    };
    return partial as SourceControlManager;
  }
}

function createRepository(changelists?: Map<string, unknown>): Repository {
  return {
    changelists: changelists ?? new Map(),
    addChangelist: vi.fn().mockResolvedValue({ exitCode: 0 }),
    removeChangelist: vi.fn().mockResolvedValue({ exitCode: 0 })
  } as unknown as Repository;
}

describe("ChangeList helper-driven behavior", () => {
  const originalHasInstance = Object.getOwnPropertyDescriptor(
    Uri as unknown as object,
    Symbol.hasInstance
  );

  beforeAll(() => {
    Object.defineProperty(Uri as unknown as object, Symbol.hasInstance, {
      configurable: true,
      value: (value: unknown) =>
        !!value &&
        typeof value === "object" &&
        "scheme" in (value as Record<string, unknown>)
    });
  });

  afterAll(() => {
    if (originalHasInstance) {
      Object.defineProperty(
        Uri as unknown as object,
        Symbol.hasInstance,
        originalHasInstance
      );
    } else {
      delete (Uri as unknown as { [Symbol.hasInstance]?: unknown })[
        Symbol.hasInstance
      ];
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { activeTextEditor?: unknown }).activeTextEditor =
      undefined;
  });

  it("resolves uris from explorer multi-select args", async () => {
    const repo = createRepository();
    const getRepositoryFromUri = vi.fn().mockReturnValue(repo);
    const inputSwitchSpy = vi
      .spyOn(changelistItems, "inputSwitchChangelist")
      .mockResolvedValue(undefined);
    const command = new TestChangeList(getRepositoryFromUri);
    const uri1 = Uri.file("/repo/a.txt") as unknown as Uri;
    const uri2 = Uri.file("/repo/b.txt") as unknown as Uri;

    await command.execute(
      uri1 as unknown as Resource,
      [uri1, uri2] as unknown as Uri[]
    );

    expect(getRepositoryFromUri).toHaveBeenCalledTimes(2);
    expect(getRepositoryFromUri).toHaveBeenNthCalledWith(1, uri1);
    expect(getRepositoryFromUri).toHaveBeenNthCalledWith(2, uri2);
    expect(inputSwitchSpy).toHaveBeenCalledWith(repo, false);
  });

  it("resolves uri from active editor when called without args", async () => {
    const repo = createRepository();
    const getRepositoryFromUri = vi.fn().mockReturnValue(repo);
    const inputSwitchSpy = vi
      .spyOn(changelistItems, "inputSwitchChangelist")
      .mockResolvedValue(undefined);
    const command = new TestChangeList(getRepositoryFromUri);
    const editorUri = Uri.file("/repo/active.txt") as unknown as Uri;

    (
      window as unknown as {
        activeTextEditor?: { document: { uri: Uri } };
      }
    ).activeTextEditor = { document: { uri: editorUri } };

    await command.execute();

    expect(getRepositoryFromUri).toHaveBeenCalledTimes(1);
    expect(getRepositoryFromUri).toHaveBeenCalledWith(editorUri);
    expect(inputSwitchSpy).toHaveBeenCalledWith(repo, false);
  });

  it("shows error when selected files belong to different repositories", async () => {
    const repo1 = createRepository();
    const repo2 = createRepository();
    const getRepositoryFromUri = vi.fn((uri: Uri) =>
      uri.fsPath.includes("repo1") ? repo1 : repo2
    );
    const inputSwitchSpy = vi
      .spyOn(changelistItems, "inputSwitchChangelist")
      .mockResolvedValue(undefined);
    const command = new TestChangeList(getRepositoryFromUri);
    const resource1 = new Resource(
      Uri.file("/repo1/a.txt") as unknown as Uri,
      Status.MODIFIED
    );
    const resource2 = new Resource(
      Uri.file("/repo2/b.txt") as unknown as Uri,
      Status.MODIFIED
    );

    await command.execute(resource1, resource2);

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      "Unable to add files from different repositories to change list"
    );
    expect(inputSwitchSpy).not.toHaveBeenCalled();
  });

  it("shows error when some selected files are not versioned", async () => {
    const repo = createRepository();
    const getRepositoryFromUri = vi.fn((uri: Uri) =>
      uri.fsPath === "/repo/tracked.txt" ? repo : null
    );
    const inputSwitchSpy = vi
      .spyOn(changelistItems, "inputSwitchChangelist")
      .mockResolvedValue(undefined);
    const command = new TestChangeList(getRepositoryFromUri);
    const versioned = new Resource(
      Uri.file("/repo/tracked.txt") as unknown as Uri,
      Status.MODIFIED
    );
    const unversioned = new Resource(
      Uri.file("/repo/untracked.txt") as unknown as Uri,
      Status.MODIFIED
    );

    await command.execute(versioned, unversioned);

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      "Some Files are not under version control and cannot be added to a change list"
    );
    expect(inputSwitchSpy).not.toHaveBeenCalled();
  });

  it("sets canRemove=true when changelist already contains selected path", async () => {
    const changelists = new Map<string, unknown>([
      [
        "existing",
        {
          resourceStates: [
            { resourceUri: { path: "\\repo\\folder\\file.txt" } }
          ]
        }
      ]
    ]);
    const repo = createRepository(changelists);
    const getRepositoryFromUri = vi.fn().mockReturnValue(repo);
    const inputSwitchSpy = vi
      .spyOn(changelistItems, "inputSwitchChangelist")
      .mockResolvedValue(undefined);
    const command = new TestChangeList(getRepositoryFromUri);
    const resource = new Resource(
      Uri.file("/repo/folder/file.txt") as unknown as Uri,
      Status.MODIFIED
    );

    await command.execute(resource);

    expect(inputSwitchSpy).toHaveBeenCalledWith(repo, true);
  });

  it("shows exact success message when adding to changelist", async () => {
    const repo = createRepository();
    const getRepositoryFromUri = vi.fn().mockReturnValue(repo);
    vi.spyOn(changelistItems, "inputSwitchChangelist").mockResolvedValue(
      "feature-x"
    );
    const command = new TestChangeList(getRepositoryFromUri);
    const resource = new Resource(
      Uri.file("/repo/file.txt") as unknown as Uri,
      Status.MODIFIED
    );

    await command.execute(resource);

    // Success confirmation is inline status-bar feedback, not a toast
    expect(window.setStatusBarMessage).toHaveBeenCalledWith(
      'Added files "/repo/file.txt" to changelist "feature-x"',
      expect.any(Number)
    );
  });
});
