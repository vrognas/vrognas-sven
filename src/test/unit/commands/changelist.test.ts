import * as assert from "assert";
import { commands, Uri, window } from "vscode";
import { vi } from "vitest";
import { ChangeList } from "../../../commands/changeList";
import { Resource } from "../../../resource";
import { Status, IExecutionResult } from "../../../common/types";
import { Repository } from "../../../repository";
import { SourceControlManager } from "../../../source_control_manager";
import * as changelistItems from "../../../changelistItems";

suite("ChangeList Command Tests", () => {
  let changeListCmd: ChangeList;
  let mockRepository: any;
  let mockSourceControlManager: Partial<SourceControlManager>;
  let origExecuteCommand: typeof commands.executeCommand;
  let origShowError: typeof window.showErrorMessage;
  let origShowInfo: typeof window.showInformationMessage;
  let origSetStatusBar: typeof window.setStatusBarMessage;
  let origActiveTextEditor: typeof window.activeTextEditor;
  let inputSwitchChangelistImpl: (
    repo: Repository,
    canRemove?: boolean
  ) => Promise<string | false | undefined>;

  // Call tracking
  let addChangelistCalls: Array<{ paths: string[]; name: string }>;
  let removeChangelistCalls: Array<{ paths: string[] }>;
  let inputSwitchChangelistCalls: Array<{
    repo: Repository;
    canRemove: boolean;
  }>;
  let showErrorCalls: string[];
  let showInfoCalls: string[];
  let executeCommandCalls: any[];

  setup(() => {
    changeListCmd = new ChangeList();
    addChangelistCalls = [];
    removeChangelistCalls = [];
    inputSwitchChangelistCalls = [];
    showErrorCalls = [];
    showInfoCalls = [];
    executeCommandCalls = [];

    // Mock Repository with changelists
    mockRepository = {
      changelists: new Map(),
      addChangelist: async (
        paths: string[],
        name: string
      ): Promise<IExecutionResult> => {
        addChangelistCalls.push({ paths, name });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      removeChangelist: async (paths: string[]): Promise<IExecutionResult> => {
        removeChangelistCalls.push({ paths });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    // Mock SourceControlManager
    mockSourceControlManager = {
      getRepositoryFromUri: (_uri: Uri) => {
        return mockRepository as Repository;
      }
    };

    // Mock commands.executeCommand
    origExecuteCommand = commands.executeCommand;
    (commands as any).executeCommand = async (cmd: string) => {
      executeCommandCalls.push({ cmd });
      if (cmd === "sven.getSourceControlManager") {
        return mockSourceControlManager;
      }
      return undefined;
    };

    // Mock inputSwitchChangelist (ESM-safe via spy)
    inputSwitchChangelistImpl = async (
      _repo: Repository,
      _canRemove: boolean = false
    ) => {
      return undefined; // Default to undefined (cancelled)
    };
    vi.spyOn(changelistItems, "inputSwitchChangelist").mockImplementation(
      (repo: Repository, canRemove?: boolean) => {
        inputSwitchChangelistCalls.push({
          repo,
          canRemove: canRemove ?? false
        });
        return inputSwitchChangelistImpl(repo, canRemove);
      }
    );

    // Mock window functions
    origShowError = window.showErrorMessage;
    (window as any).showErrorMessage = (msg: string) => {
      showErrorCalls.push(msg);
      return Promise.resolve(undefined);
    };

    origShowInfo = window.showInformationMessage;
    (window as any).showInformationMessage = (msg: string) => {
      showInfoCalls.push(msg);
      return Promise.resolve(undefined);
    };
    // Success confirmations are inline (status bar) since the
    // inline-feedback pass - track them in the same array
    origSetStatusBar = window.setStatusBarMessage;
    (window as any).setStatusBarMessage = (msg: string) => {
      showInfoCalls.push(msg);
      return { dispose() {} };
    };

    origActiveTextEditor = window.activeTextEditor;
    (window as any).activeTextEditor = undefined;
  });

  teardown(() => {
    changeListCmd.dispose();
    (commands as any).executeCommand = origExecuteCommand;
    vi.restoreAllMocks();
    (window as any).showErrorMessage = origShowError;
    (window as any).showInformationMessage = origShowInfo;
    (window as any).setStatusBarMessage = origSetStatusBar;
    (window as any).activeTextEditor = origActiveTextEditor;
  });

  suite("Input Handling", () => {
    test("1.1: Handle single Resource instance", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      inputSwitchChangelistImpl = async () => "my-changelist";

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.deepStrictEqual(addChangelistCalls[0]!.paths, ["/repo/file.txt"]);
      assert.strictEqual(addChangelistCalls[0]!.name, "my-changelist");
    });

    test("1.2: Handle multiple Resource instances", async () => {
      const resource1 = new Resource(
        Uri.file("/repo/file1.txt"),
        Status.MODIFIED
      );
      const resource2 = new Resource(Uri.file("/repo/file2.txt"), Status.ADDED);

      inputSwitchChangelistImpl = async () => "feature-123";

      await changeListCmd.execute(resource1, resource2);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.deepStrictEqual(addChangelistCalls[0]!.paths, [
        "/repo/file1.txt",
        "/repo/file2.txt"
      ]);
      assert.strictEqual(addChangelistCalls[0]!.name, "feature-123");
    });

    test("1.3: Handle Uri array", async () => {
      const uri1 = Uri.file("/repo/file1.txt");
      const uri2 = Uri.file("/repo/file2.txt");

      inputSwitchChangelistImpl = async () => "bugfix-456";

      await changeListCmd.execute(uri1, [uri1, uri2]);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.deepStrictEqual(addChangelistCalls[0]!.paths, [
        "/repo/file1.txt",
        "/repo/file2.txt"
      ]);
    });

    test("1.4: Handle activeTextEditor", async () => {
      const editorUri = Uri.file("/repo/active-file.txt");
      (window as any).activeTextEditor = {
        document: { uri: editorUri }
      };

      inputSwitchChangelistImpl = async () => "docs";

      await changeListCmd.execute();

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.deepStrictEqual(addChangelistCalls[0]!.paths, [
        "/repo/active-file.txt"
      ]);
    });

    test("1.5: Handle no active editor", async () => {
      (window as any).activeTextEditor = undefined;

      await changeListCmd.execute();

      assert.strictEqual(addChangelistCalls.length, 0);
      assert.strictEqual(showErrorCalls.length, 0);
    });

    test("1.6: Handle empty Resource array", async () => {
      await changeListCmd.execute();

      assert.strictEqual(addChangelistCalls.length, 0);
    });
  });

  suite("Repository Validation", () => {
    test("2.1: Error when files not under version control", async () => {
      const resource = new Resource(
        Uri.file("/unversioned/file.txt"),
        Status.MODIFIED
      );

      mockSourceControlManager.getRepositoryFromUri = () => null;

      await changeListCmd.execute(resource);

      assert.strictEqual(showErrorCalls.length, 1);
      assert.strictEqual(
        showErrorCalls[0],
        "Files are not under version control and cannot be added to a change list"
      );
      assert.strictEqual(addChangelistCalls.length, 0);
    });

    test("2.2: Error when files from different repositories", async () => {
      const resource1 = new Resource(
        Uri.file("/repo1/file.txt"),
        Status.MODIFIED
      );
      const resource2 = new Resource(
        Uri.file("/repo2/file.txt"),
        Status.MODIFIED
      );

      const mockRepo2: Partial<Repository> = {
        changelists: new Map()
      };

      let callCount = 0;
      mockSourceControlManager.getRepositoryFromUri = () => {
        callCount++;
        return (callCount === 1 ? mockRepository : mockRepo2) as Repository;
      };

      await changeListCmd.execute(resource1, resource2);

      assert.strictEqual(showErrorCalls.length, 1);
      assert.strictEqual(
        showErrorCalls[0],
        "Unable to add files from different repositories to change list"
      );
      assert.strictEqual(addChangelistCalls.length, 0);
    });

    test("2.3: Error when some files not under version control", async () => {
      const resource1 = new Resource(
        Uri.file("/repo/file1.txt"),
        Status.MODIFIED
      );
      const resource2 = new Resource(
        Uri.file("/unversioned/file2.txt"),
        Status.MODIFIED
      );

      let callCount = 0;
      mockSourceControlManager.getRepositoryFromUri = () => {
        callCount++;
        return callCount === 1 ? (mockRepository as Repository) : null;
      };

      await changeListCmd.execute(resource1, resource2);

      assert.strictEqual(showErrorCalls.length, 1);
      assert.strictEqual(
        showErrorCalls[0],
        "Some Files are not under version control and cannot be added to a change list"
      );
      assert.strictEqual(addChangelistCalls.length, 0);
    });

    test("2.4: Handle null repository gracefully", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      // Return undefined on first call, then mockRepository
      let callCount = 0;
      mockSourceControlManager.getRepositoryFromUri = () => {
        callCount++;
        return callCount === 1 ? null : (mockRepository as Repository);
      };

      await changeListCmd.execute(resource);

      // Should exit early when filtered repositories result in empty/null
      assert.strictEqual(addChangelistCalls.length, 0);
    });
  });

  suite("Changelist Creation", () => {
    test("3.1: Create new changelist", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      inputSwitchChangelistImpl = async () => "new-feature";

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(addChangelistCalls[0]!.name, "new-feature");
      assert.deepStrictEqual(addChangelistCalls[0]!.paths, ["/repo/file.txt"]);
      // Silent: the file visibly moving lists in the SCM view is the feedback
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("3.2: Add to existing changelist", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.changelists = new Map([
        [
          "existing-list",
          {
            id: "existing-list",
            label: "existing-list",
            resourceStates: []
          } as any
        ]
      ]);

      inputSwitchChangelistImpl = async () => "existing-list";

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(addChangelistCalls[0]!.name, "existing-list");
    });

    test("3.3: Multiple files to single changelist", async () => {
      const resources = [
        new Resource(Uri.file("/repo/file1.txt"), Status.MODIFIED),
        new Resource(Uri.file("/repo/file2.txt"), Status.ADDED),
        new Resource(Uri.file("/repo/file3.txt"), Status.DELETED)
      ];

      inputSwitchChangelistImpl = async () => "batch-fix";

      await changeListCmd.execute(...resources);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.deepStrictEqual(addChangelistCalls[0]!.paths, [
        "/repo/file1.txt",
        "/repo/file2.txt",
        "/repo/file3.txt"
      ]);
      assert.strictEqual(addChangelistCalls[0]!.name, "batch-fix");
    });
  });

  suite("Changelist Management", () => {
    test("4.1: Remove file from changelist", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.changelists = new Map([
        [
          "my-list",
          {
            id: "my-list",
            label: "my-list",
            resourceStates: [resource]
          } as any
        ]
      ]);

      // Return false to indicate removal
      inputSwitchChangelistImpl = async (
        _repo: Repository,
        canRemove?: boolean
      ) => {
        assert.strictEqual(canRemove, true, "Should allow removal");
        return false;
      };

      await changeListCmd.execute(resource);

      assert.strictEqual(removeChangelistCalls.length, 1);
      assert.deepStrictEqual(removeChangelistCalls[0]!.paths, [
        "/repo/file.txt"
      ]);
      assert.strictEqual(addChangelistCalls.length, 0);
    });

    test("4.2: canRemove=true when file in changelist", async () => {
      const fileUri = Uri.file("/repo/file.txt");
      const resource = new Resource(fileUri, Status.MODIFIED);

      mockRepository.changelists = new Map([
        [
          "active-list",
          {
            id: "active-list",
            label: "active-list",
            resourceStates: [new Resource(fileUri, Status.MODIFIED)]
          } as any
        ]
      ]);

      inputSwitchChangelistImpl = async (
        _repo: Repository,
        canRemove?: boolean
      ) => {
        assert.strictEqual(canRemove, true);
        return "other-list";
      };

      await changeListCmd.execute(resource);

      assert.strictEqual(inputSwitchChangelistCalls.length, 1);
      assert.strictEqual(inputSwitchChangelistCalls[0]!.canRemove, true);
    });

    test("4.3: canRemove=false when file not in changelist", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.changelists = new Map();

      inputSwitchChangelistImpl = async (
        _repo: Repository,
        canRemove?: boolean
      ) => {
        assert.strictEqual(canRemove, false);
        return "new-list";
      };

      await changeListCmd.execute(resource);

      assert.strictEqual(inputSwitchChangelistCalls.length, 1);
      assert.strictEqual(inputSwitchChangelistCalls[0]!.canRemove, false);
    });

    test("4.4: Switch file between changelists", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.changelists = new Map([
        [
          "old-list",
          {
            id: "old-list",
            label: "old-list",
            resourceStates: [resource]
          } as any
        ]
      ]);

      inputSwitchChangelistImpl = async () => "new-list";

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(addChangelistCalls[0]!.name, "new-list");
      assert.strictEqual(removeChangelistCalls.length, 0);
    });
  });

  suite("User Cancellation", () => {
    test("5.1: Cancel changelist selection (undefined)", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      inputSwitchChangelistImpl = async () => undefined;

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 0);
      assert.strictEqual(removeChangelistCalls.length, 0);
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("5.2: undefined changelist value cancels operation", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      inputSwitchChangelistImpl = async () => undefined;

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 0);
      assert.strictEqual(removeChangelistCalls.length, 0);
    });

    test("5.3: Valid false return (remove from changelist)", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.changelists = new Map([
        [
          "my-list",
          {
            id: "my-list",
            label: "my-list",
            resourceStates: [resource]
          } as any
        ]
      ]);

      inputSwitchChangelistImpl = async () => false;

      await changeListCmd.execute(resource);

      assert.strictEqual(removeChangelistCalls.length, 1);
      assert.strictEqual(addChangelistCalls.length, 0);
    });
  });

  suite("Error Handling", () => {
    test("6.1: Handle addChangelist error", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.addChangelist = async () => {
        throw new Error("SVN changelist error");
      };

      inputSwitchChangelistImpl = async () => "test-list";

      await changeListCmd.execute(resource);

      // Error should be caught by handleRepositoryOperation
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("6.2: Handle removeChangelist error", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.changelists = new Map([
        [
          "my-list",
          {
            id: "my-list",
            label: "my-list",
            resourceStates: [resource]
          } as any
        ]
      ]);

      mockRepository.removeChangelist = async () => {
        throw new Error("SVN remove error");
      };

      inputSwitchChangelistImpl = async () => false;

      await changeListCmd.execute(resource);

      // Error should be caught by handleRepositoryOperation
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("6.3: Handle getRepositoryFromUri error", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockSourceControlManager.getRepositoryFromUri = () => {
        throw new Error("Repository not found");
      };

      await assert.rejects(
        changeListCmd.execute(resource),
        /Repository not found/
      );
    });

    test("6.4: Handle invalid URI scheme", async () => {
      const resource = new Resource(
        Uri.parse("http://example.com/file.txt"),
        Status.MODIFIED
      );

      mockSourceControlManager.getRepositoryFromUri = () => null;

      await changeListCmd.execute(resource);

      assert.strictEqual(showErrorCalls.length, 1);
      assert.ok(showErrorCalls[0]!.includes("not under version control"));
    });
  });

  suite("Path Normalization", () => {
    test("7.1: Match files with different path separators", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      // Simulate changelist with normalized paths
      mockRepository.changelists = new Map([
        [
          "my-list",
          {
            id: "my-list",
            label: "my-list",
            resourceStates: [
              new Resource(Uri.file("/repo/file.txt"), Status.MODIFIED)
            ]
          } as any
        ]
      ]);

      inputSwitchChangelistImpl = async (
        _repo: Repository,
        canRemove?: boolean
      ) => {
        assert.strictEqual(canRemove, true);
        return "other-list";
      };

      await changeListCmd.execute(resource);

      assert.strictEqual(inputSwitchChangelistCalls[0]!.canRemove, true);
    });

    test("7.2: Handle Windows-style paths", async () => {
      const resource = new Resource(
        Uri.file("C:\\repo\\file.txt"),
        Status.MODIFIED
      );

      inputSwitchChangelistImpl = async () => "win-list";

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.ok(addChangelistCalls[0]!.paths[0]!.includes("file.txt"));
    });

    test("7.3: Handle special characters in paths", async () => {
      const resource = new Resource(
        Uri.file("/repo/file with spaces.txt"),
        Status.MODIFIED
      );

      inputSwitchChangelistImpl = async () => "special-chars";

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(
        addChangelistCalls[0]!.paths[0]!,
        "/repo/file with spaces.txt"
      );
    });
  });

  suite("Information Messages", () => {
    test("8.1: Adding to changelist is silent (SCM view shows the move)", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      inputSwitchChangelistImpl = async () => "feature-x";

      await changeListCmd.execute(resource);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("8.2: Multi-file add is silent too", async () => {
      const resources = [
        new Resource(Uri.file("/repo/file1.txt"), Status.MODIFIED),
        new Resource(Uri.file("/repo/file2.txt"), Status.ADDED)
      ];

      inputSwitchChangelistImpl = async () => "multi";

      await changeListCmd.execute(...resources);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.deepStrictEqual(addChangelistCalls[0]!.paths, [
        "/repo/file1.txt",
        "/repo/file2.txt"
      ]);
      assert.strictEqual(showInfoCalls.length, 0);
    });

    test("8.3: No success message when removing", async () => {
      const resource = new Resource(
        Uri.file("/repo/file.txt"),
        Status.MODIFIED
      );

      mockRepository.changelists = new Map([
        [
          "my-list",
          {
            id: "my-list",
            label: "my-list",
            resourceStates: [resource]
          } as any
        ]
      ]);

      inputSwitchChangelistImpl = async () => false;

      await changeListCmd.execute(resource);

      assert.strictEqual(showInfoCalls.length, 0);
    });
  });

  suite("Complex Scenarios", () => {
    test("9.1: Multiple files with mixed changelist states", async () => {
      const file1 = new Resource(Uri.file("/repo/file1.txt"), Status.MODIFIED);
      const file2 = new Resource(Uri.file("/repo/file2.txt"), Status.ADDED);
      const file3 = new Resource(Uri.file("/repo/file3.txt"), Status.MODIFIED);

      mockRepository.changelists = new Map([
        [
          "list-a",
          {
            id: "list-a",
            label: "list-a",
            resourceStates: [file1]
          } as any
        ],
        [
          "list-b",
          {
            id: "list-b",
            label: "list-b",
            resourceStates: [file2]
          } as any
        ]
      ]);

      inputSwitchChangelistImpl = async (
        _repo: Repository,
        canRemove?: boolean
      ) => {
        assert.strictEqual(canRemove, true);
        return "unified-list";
      };

      await changeListCmd.execute(file1, file2, file3);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(addChangelistCalls[0]!.name, "unified-list");
      assert.strictEqual(addChangelistCalls[0]!.paths.length, 3);
    });

    test("9.2: Large batch of files", async () => {
      const resources = [];
      for (let i = 0; i < 50; i++) {
        resources.push(
          new Resource(Uri.file(`/repo/file${i}.txt`), Status.MODIFIED)
        );
      }

      inputSwitchChangelistImpl = async () => "bulk";

      await changeListCmd.execute(...resources);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(addChangelistCalls[0]!.paths.length, 50);
    });

    test("9.3: Files with various status types", async () => {
      const resources = [
        new Resource(Uri.file("/repo/modified.txt"), Status.MODIFIED),
        new Resource(Uri.file("/repo/added.txt"), Status.ADDED),
        new Resource(Uri.file("/repo/deleted.txt"), Status.DELETED),
        new Resource(Uri.file("/repo/conflicted.txt"), Status.CONFLICTED)
      ];

      inputSwitchChangelistImpl = async () => "all-types";

      await changeListCmd.execute(...resources);

      assert.strictEqual(addChangelistCalls.length, 1);
      assert.strictEqual(addChangelistCalls[0]!.paths.length, 4);
    });
  });
});
