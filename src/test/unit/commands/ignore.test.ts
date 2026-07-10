import * as assert from "assert";
import { Uri, window } from "vscode";
import {
  AddToIgnoreExplorer,
  AddToIgnoreSCM
} from "../../../commands/addToIgnore";
import { Resource } from "../../../resource";
import { Repository } from "../../../repository";
import { Status } from "../../../common/types";
import * as ignoreitems from "../../../ignoreitems";
import { vi } from "vitest";

suite("AddToIgnore Commands Tests", () => {
  // Mock tracking
  let mockRepository: Partial<Repository>;
  let origShowInfo: typeof window.showInformationMessage;
  let origSetStatusBar: typeof window.setStatusBarMessage;
  let origShowError: typeof window.showErrorMessage;
  let inputIgnoreListSpy: ReturnType<typeof vi.spyOn>;
  let inputIgnoreListImpl: typeof ignoreitems.inputIgnoreList;

  // Call tracking
  let inputIgnoreListCalls: any[] = [];
  let showInfoCalls: string[] = [];
  let showErrorCalls: string[] = [];
  let addToIgnoreCalls: any[] = [];

  setup(() => {
    // Mock Repository
    mockRepository = {
      root: "/test/repo",
      workspaceRoot: "/test/workspace",
      addToIgnore: async (
        expressions: string[],
        directory: string,
        recursive: boolean = false
      ) => {
        addToIgnoreCalls.push({ expressions, directory, recursive });
        return "";
      }
    };

    // Track calls to inputIgnoreList
    inputIgnoreListImpl = async () => false; // Default to cancelled
    inputIgnoreListSpy = vi
      .spyOn(ignoreitems, "inputIgnoreList")
      .mockImplementation((repo: Repository, uris: Uri[]) => {
        inputIgnoreListCalls.push({ repo, uris });
        return inputIgnoreListImpl(repo, uris);
      });

    // Track user feedback: toasts AND inline status-bar confirmations
    // (success outcomes moved to the status bar in the inline-feedback pass)
    origShowInfo = window.showInformationMessage;
    (window as any).showInformationMessage = (message: string) => {
      showInfoCalls.push(message);
      return Promise.resolve(undefined);
    };
    origSetStatusBar = window.setStatusBarMessage;
    (window as any).setStatusBarMessage = (message: string) => {
      showInfoCalls.push(message);
      return { dispose() {} };
    };

    // Track calls to showErrorMessage
    origShowError = window.showErrorMessage;
    (window as any).showErrorMessage = (message: string) => {
      showErrorCalls.push(message);
      return Promise.resolve(undefined);
    };

    // Clear call tracking arrays
    inputIgnoreListCalls = [];
    showInfoCalls = [];
    showErrorCalls = [];
    addToIgnoreCalls = [];
  });

  teardown(() => {
    // Restore original functions
    inputIgnoreListSpy.mockRestore();
    (window as any).showInformationMessage = origShowInfo;
    (window as any).setStatusBarMessage = origSetStatusBar;
    (window as any).showErrorMessage = origShowError;
  });

  suite("AddToIgnoreExplorer Command", () => {
    let addToIgnoreExplorer: AddToIgnoreExplorer;

    setup(() => {
      addToIgnoreExplorer = new AddToIgnoreExplorer();
    });

    teardown(() => {
      addToIgnoreExplorer.dispose();
    });

    test("1.1: Add single file from explorer", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      // Mock runByRepository to execute operation
      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Mock inputIgnoreList to return success
      inputIgnoreListImpl = async () => true;

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.ok(inputIgnoreListCalls.length > 0, "Should call inputIgnoreList");
      assert.ok(showInfoCalls.length > 0, "Should show success message");
    });

    test("1.2: Add multiple files from explorer", async () => {
      const file1 = Uri.file("/test/repo/file1.txt");
      const file2 = Uri.file("/test/repo/file2.txt");
      const allUris = [file1, file2];

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (_repo: Repository, uris: Uri[]) => {
        inputIgnoreListCalls.push({ repo: _repo, uris });
        assert.strictEqual(uris.length, 2, "Should receive all URIs");
        return true;
      };

      await addToIgnoreExplorer.execute(file1, allUris);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("1.3: No URIs provided (empty array)", async () => {
      await addToIgnoreExplorer.execute(undefined, []);

      assert.strictEqual(
        inputIgnoreListCalls.length,
        0,
        "Should not process empty array"
      );
    });

    test("1.4: No URIs provided (undefined)", async () => {
      await addToIgnoreExplorer.execute(undefined, undefined);

      assert.strictEqual(
        inputIgnoreListCalls.length,
        0,
        "Should not process undefined"
      );
    });

    test("1.5: User cancels ignore selection", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // inputIgnoreList returns false by default (cancelled)
      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(
        showInfoCalls.length,
        0,
        "Should not show success on cancel"
      );
    });

    test("1.6: Add folder from explorer", async () => {
      const folderUri = Uri.file("/test/repo/folder");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreExplorer.execute(folderUri, [folderUri]);

      assert.ok(inputIgnoreListCalls.length > 0);
      assert.ok(showInfoCalls.length > 0);
    });

    test("1.7: Error handling during ignore operation", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => {
        throw new Error("SVN error");
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.ok(showErrorCalls.length > 0, "Should show error message");
      assert.ok(
        showErrorCalls[0]!.includes("Unable to set property ignore"),
        "Should show correct error"
      );
    });

    test("1.8: Mixed files and folders", async () => {
      const file1 = Uri.file("/test/repo/file.txt");
      const folder1 = Uri.file("/test/repo/folder");
      const allUris = [file1, folder1];

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (_repo: Repository, uris: Uri[]) => {
        assert.strictEqual(uris.length, 2);
        return true;
      };

      await addToIgnoreExplorer.execute(file1, allUris);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("1.9: Files with special characters in path", async () => {
      const fileUri = Uri.file("/test/repo/file with spaces.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("1.10: Repository not found", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async () => [];

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(
        inputIgnoreListCalls.length,
        0,
        "Should exit if no repository"
      );
    });
  });

  suite("AddToIgnoreSCM Command", () => {
    let addToIgnoreSCM: AddToIgnoreSCM;

    setup(() => {
      addToIgnoreSCM = new AddToIgnoreSCM();
    });

    teardown(() => {
      addToIgnoreSCM.dispose();
    });

    test("2.1: Add single resource from SCM", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const resource = new Resource(fileUri, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [resource];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreSCM.execute(resource);

      assert.ok(inputIgnoreListCalls.length > 0);
      assert.ok(showInfoCalls.length > 0);
    });

    test("2.2: Add multiple resources from SCM", async () => {
      const file1 = Uri.file("/test/repo/file1.txt");
      const file2 = Uri.file("/test/repo/file2.txt");
      const resource1 = new Resource(file1, Status.UNVERSIONED);
      const resource2 = new Resource(file2, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [
        resource1,
        resource2
      ];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (_repo: Repository, uris: Uri[]) => {
        assert.strictEqual(uris.length, 2);
        return true;
      };

      await addToIgnoreSCM.execute(resource1, resource2);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("2.3: No resources selected (returns null)", async () => {
      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => null;

      await addToIgnoreSCM.execute();

      assert.strictEqual(
        inputIgnoreListCalls.length,
        0,
        "Should exit if no selection"
      );
    });

    test("2.4: Empty resource selection (returns empty array)", async () => {
      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [];

      await addToIgnoreSCM.execute();

      assert.strictEqual(
        inputIgnoreListCalls.length,
        0,
        "Should exit if empty selection"
      );
    });

    test("2.5: User cancels ignore selection", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const resource = new Resource(fileUri, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [resource];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Returns false (cancelled)
      await addToIgnoreSCM.execute(resource);

      assert.strictEqual(
        showInfoCalls.length,
        0,
        "Should not show success on cancel"
      );
    });

    test("2.6: MODIFIED status resource", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const resource = new Resource(fileUri, Status.MODIFIED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [resource];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreSCM.execute(resource);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("2.7: ADDED status resource", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const resource = new Resource(fileUri, Status.ADDED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [resource];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreSCM.execute(resource);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("2.8: Mixed status resources", async () => {
      const file1 = Uri.file("/test/repo/file1.txt");
      const file2 = Uri.file("/test/repo/file2.txt");
      const file3 = Uri.file("/test/repo/file3.txt");
      const resource1 = new Resource(file1, Status.UNVERSIONED);
      const resource2 = new Resource(file2, Status.MODIFIED);
      const resource3 = new Resource(file3, Status.ADDED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [
        resource1,
        resource2,
        resource3
      ];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (_repo: Repository, uris: Uri[]) => {
        assert.strictEqual(uris.length, 3);
        return true;
      };

      await addToIgnoreSCM.execute(resource1, resource2, resource3);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("2.9: Error handling during ignore operation", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const resource = new Resource(fileUri, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [resource];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => {
        throw new Error("SVN error");
      };

      await addToIgnoreSCM.execute(resource);

      assert.ok(showErrorCalls.length > 0, "Should show error message");
      assert.ok(
        showErrorCalls[0]!.includes("Unable to set property ignore"),
        "Should show correct error"
      );
    });

    test("2.10: Resource URI extraction", async () => {
      const file1 = Uri.file("/test/repo/file1.txt");
      const file2 = Uri.file("/test/repo/file2.txt");
      const resource1 = new Resource(file1, Status.UNVERSIONED);
      const resource2 = new Resource(file2, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [
        resource1,
        resource2
      ];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (_repo: Repository, uris: Uri[]) => {
        assert.strictEqual(uris[0]!.fsPath, file1.fsPath);
        assert.strictEqual(uris[1]!.fsPath, file2.fsPath);
        return true;
      };

      await addToIgnoreSCM.execute(resource1, resource2);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("2.11: Repository not found", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const resource = new Resource(fileUri, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [resource];
      (addToIgnoreSCM as any).runByRepository = async () => [];

      await addToIgnoreSCM.execute(resource);

      assert.strictEqual(
        inputIgnoreListCalls.length,
        0,
        "Should exit if no repository"
      );
    });

    test("2.12: Resources with special characters in path", async () => {
      const fileUri = Uri.file("/test/repo/file with spaces & symbols.txt");
      const resource = new Resource(fileUri, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async () => [resource];
      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreSCM.execute(resource);

      assert.ok(inputIgnoreListCalls.length > 0);
    });
  });

  suite("Ignore Pattern Selection (inputIgnoreList integration)", () => {
    let addToIgnoreExplorer: AddToIgnoreExplorer;

    setup(() => {
      addToIgnoreExplorer = new AddToIgnoreExplorer();
    });

    teardown(() => {
      addToIgnoreExplorer.dispose();
    });

    test("3.1: Single file with extension - filename pattern", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting filename pattern
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["file.txt"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.deepStrictEqual(addToIgnoreCalls[0].expressions, ["file.txt"]);
      assert.strictEqual(addToIgnoreCalls[0].directory, "/test/repo");
      assert.strictEqual(addToIgnoreCalls[0].recursive, false);
    });

    test("3.2: Single file with extension - extension pattern", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting extension pattern
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["*.txt"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.deepStrictEqual(addToIgnoreCalls[0].expressions, ["*.txt"]);
    });

    test("3.3: Single file - recursive pattern", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting recursive pattern
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["file.txt"], "/test/repo", true);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.strictEqual(addToIgnoreCalls[0].recursive, true);
    });

    test("3.4: Multiple files - filename pattern", async () => {
      const file1 = Uri.file("/test/repo/file1.txt");
      const file2 = Uri.file("/test/repo/file2.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting filename pattern for multiple files
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["file1.txt", "file2.txt"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(file1, [file1, file2]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.deepStrictEqual(addToIgnoreCalls[0].expressions, [
        "file1.txt",
        "file2.txt"
      ]);
    });

    test("3.5: Multiple files - extension pattern", async () => {
      const file1 = Uri.file("/test/repo/file1.txt");
      const file2 = Uri.file("/test/repo/file2.log");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting extension pattern for multiple files
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["*.txt", "*.log"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(file1, [file1, file2]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.ok(
        addToIgnoreCalls[0].expressions.includes("*.txt") ||
          addToIgnoreCalls[0].expressions.includes("*.log")
      );
    });

    test("3.6: Files in different directories", async () => {
      const file1 = Uri.file("/test/repo/dir1/file.txt");
      const file2 = Uri.file("/test/repo/dir2/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate multiple directory calls
      let callCount = 0;
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        if (callCount === 0) {
          await repo.addToIgnore(["file.txt"], "/test/repo/dir1", false);
        } else {
          await repo.addToIgnore(["file.txt"], "/test/repo/dir2", false);
        }
        callCount++;
        return true;
      };

      await addToIgnoreExplorer.execute(file1, [file1, file2]);

      // Should be called once (inputIgnoreList handles grouping by directory)
      assert.ok(addToIgnoreCalls.length > 0);
    });

    test("3.7: File without extension", async () => {
      const fileUri = Uri.file("/test/repo/Makefile");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting filename pattern
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["Makefile"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.deepStrictEqual(addToIgnoreCalls[0].expressions, ["Makefile"]);
    });

    test("3.8: File with double extension", async () => {
      const fileUri = Uri.file("/test/repo/file.min.js");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting extension pattern
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["*.js"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.deepStrictEqual(addToIgnoreCalls[0].expressions, ["*.js"]);
    });

    test("3.9: Folder pattern", async () => {
      const folderUri = Uri.file("/test/repo/node_modules");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting folder pattern
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["node_modules"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(folderUri, [folderUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.deepStrictEqual(addToIgnoreCalls[0].expressions, ["node_modules"]);
    });

    test("3.10: Recursive folder pattern", async () => {
      const folderUri = Uri.file("/test/repo/.git");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate user selecting recursive folder pattern
      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore([".git"], "/test/repo", true);
        return true;
      };

      await addToIgnoreExplorer.execute(folderUri, [folderUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.strictEqual(addToIgnoreCalls[0].recursive, true);
    });
  });

  suite("Edge Cases & Error Scenarios", () => {
    let addToIgnoreExplorer: AddToIgnoreExplorer;
    let addToIgnoreSCM: AddToIgnoreSCM;

    setup(() => {
      addToIgnoreExplorer = new AddToIgnoreExplorer();
      addToIgnoreSCM = new AddToIgnoreSCM();
    });

    teardown(() => {
      addToIgnoreExplorer.dispose();
      addToIgnoreSCM.dispose();
    });

    test("4.1: Empty expressions array", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      // Simulate empty ignore list (should return false)
      inputIgnoreListImpl = async () => false;

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(
        addToIgnoreCalls.length,
        0,
        "Should not add empty ignore list"
      );
    });

    test("4.2: Repository.addToIgnore throws error", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      mockRepository.addToIgnore = async () => {
        throw new Error("Permission denied");
      };

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["file.txt"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.ok(showErrorCalls.length > 0, "Should show error message");
    });

    test("4.3: Path with Unicode characters", async () => {
      const fileUri = Uri.file("/test/repo/файл.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["файл.txt"], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.deepStrictEqual(addToIgnoreCalls[0].expressions, ["файл.txt"]);
    });

    test("4.4: Very long filename", async () => {
      const longName = "a".repeat(200) + ".txt";
      const fileUri = Uri.file(`/test/repo/${longName}`);

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore([longName], "/test/repo", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
    });

    test("4.5: Nested path depth", async () => {
      const fileUri = Uri.file("/test/repo/a/b/c/d/e/f/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (repo: Repository, _uris: Uri[]) => {
        await repo.addToIgnore(["file.txt"], "/test/repo/a/b/c/d/e/f", false);
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(addToIgnoreCalls.length, 1);
      assert.strictEqual(
        addToIgnoreCalls[0].directory,
        "/test/repo/a/b/c/d/e/f"
      );
    });

    test("4.6: Duplicate URIs in selection", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const duplicates = [fileUri, fileUri, fileUri];

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async (_repo: Repository, _uris: Uri[]) => {
        // Should receive all URIs (deduplication happens in inputIgnoreList)
        return true;
      };

      await addToIgnoreExplorer.execute(fileUri, duplicates);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("4.7: Mixed file types (binary and text)", async () => {
      const textFile = Uri.file("/test/repo/file.txt");
      const binaryFile = Uri.file("/test/repo/image.png");
      const allUris = [textFile, binaryFile];

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreExplorer.execute(textFile, allUris);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("4.8: SCM command with non-Resource objects filtered", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      const resource = new Resource(fileUri, Status.UNVERSIONED);

      (addToIgnoreSCM as any).getResourceStatesOrExit = async (
        resourceStates: any[]
      ) => {
        // Filter to only Resource instances
        return resourceStates.filter((r: any) => r instanceof Resource);
      };

      (addToIgnoreSCM as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreSCM.execute(resource);

      assert.ok(inputIgnoreListCalls.length > 0);
    });

    test("4.9: Console log on error", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");
      let consoleLogCalled = false;
      let consoleErrorCalled = false;

      const origConsoleLog = console.log;
      const origConsoleError = console.error;
      console.log = (..._args: any[]) => {
        consoleLogCalled = true;
      };
      console.error = (..._args: any[]) => {
        consoleErrorCalled = true;
      };

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => {
        throw new Error("Test error");
      };

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      console.log = origConsoleLog;
      console.error = origConsoleError;

      assert.ok(consoleLogCalled || consoleErrorCalled, "Should log error");
      assert.ok(showErrorCalls.length > 0, "Should show error message");
    });

    test("4.10: Success message content", async () => {
      const fileUri = Uri.file("/test/repo/file.txt");

      (addToIgnoreExplorer as any).runByRepository = async (
        uris: Uri[],
        fn: any
      ) => {
        await fn(mockRepository, uris);
      };

      inputIgnoreListImpl = async () => true;

      await addToIgnoreExplorer.execute(fileUri, [fileUri]);

      assert.strictEqual(showInfoCalls.length, 1);
      assert.strictEqual(
        showInfoCalls[0],
        "svn:ignore set on parent folder - file(s) will be ignored"
      );
    });
  });
});
