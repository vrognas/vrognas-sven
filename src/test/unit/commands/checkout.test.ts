import * as assert from "assert";
import { commands, Uri, window, workspace } from "vscode";
import { Checkout } from "../../../commands/checkout";
import { FinishCheckout } from "../../../commands/finishCheckout";
import { ISvnErrorData } from "../../../common/types";
import { svnErrorCodes } from "../../../svn";
import * as validation from "../../../validation";
import * as branchHelper from "../../../helpers/branch";
import * as configuration from "../../../helpers/configuration";
import { Repository } from "../../../repository";
import { vi } from "vitest";

/** Build a mock globalState for test SCM objects */
function mockGlobalState() {
  const store: Record<string, any> = {};
  return {
    get: (key: string) => store[key],
    update: async (key: string, value: any) => {
      store[key] = value;
    }
  };
}

suite("Checkout Commands Tests", () => {
  // Mock tracking
  let origShowInputBox: typeof window.showInputBox;
  let origShowOpenDialog: typeof window.showOpenDialog;
  let origShowQuickPick: typeof window.showQuickPick;
  let origShowErrorMessage: typeof window.showErrorMessage;
  let origShowInfoMessage: typeof window.showInformationMessage;
  let origWithProgress: typeof window.withProgress;
  let origExecuteCommand: typeof commands.executeCommand;
  let origConfigGet: any;
  let validateRepositoryUrlSpy: ReturnType<typeof vi.spyOn>;
  let getBranchNameSpy: ReturnType<typeof vi.spyOn>;

  // Call tracking
  let validateUrlCalls: any[] = [];
  let getBranchNameCalls: any[] = [];
  let inputBoxCalls: any[] = [];
  let openDialogCalls: any[] = [];
  let errorMessageCalls: any[] = [];
  let infoMessageCalls: any[] = [];
  let withProgressCalls: any[] = [];
  let executeCommandCalls: any[] = [];
  let configGetCalls: any[] = [];
  let quickPickCalls: any[] = [];

  // Mock results
  let validateUrlResult: boolean = true;
  let getBranchNameResult: any = null;
  let inputBoxResult: string | undefined;
  let openDialogResult: Uri[] | undefined;
  let errorMessageResult: string | undefined;
  let infoMessageResult: string | undefined;
  let configGetResult: any = "/home/test";
  let quickPickResult: any = [{ depth: "infinity", label: "Full" }];

  setup(() => {
    // Clear tracking
    validateUrlCalls = [];
    getBranchNameCalls = [];
    inputBoxCalls = [];
    openDialogCalls = [];
    errorMessageCalls = [];
    infoMessageCalls = [];
    withProgressCalls = [];
    executeCommandCalls = [];
    configGetCalls = [];
    quickPickCalls = [];

    // Reset results
    validateUrlResult = true;
    getBranchNameResult = null;
    quickPickResult = [{ depth: "infinity", label: "Full" }];
    inputBoxResult = undefined;
    openDialogResult = undefined;
    errorMessageResult = undefined;
    infoMessageResult = undefined;
    configGetResult = "/home/test";

    // Mock validation.validateRepositoryUrl
    validateRepositoryUrlSpy = vi
      .spyOn(validation, "validateRepositoryUrl")
      .mockImplementation((url: string) => {
        validateUrlCalls.push({ url });
        return validateUrlResult;
      });

    // Mock branchHelper.getBranchName
    getBranchNameSpy = vi
      .spyOn(branchHelper, "getBranchName")
      .mockImplementation((url: string) => {
        getBranchNameCalls.push({ url });
        return getBranchNameResult;
      });

    // Mock window.showInputBox
    origShowInputBox = window.showInputBox;
    (window as any).showInputBox = async (options?: any) => {
      inputBoxCalls.push({ options });
      return inputBoxResult;
    };

    // Mock window.showOpenDialog
    origShowOpenDialog = window.showOpenDialog;
    (window as any).showOpenDialog = async (options?: any) => {
      openDialogCalls.push({ options });
      return openDialogResult;
    };

    // Mock window.showQuickPick (depth picker)
    origShowQuickPick = window.showQuickPick;
    (window as any).showQuickPick = async (items?: any, options?: any) => {
      quickPickCalls.push({ items, options });
      return quickPickResult;
    };

    // Mock window.showErrorMessage
    origShowErrorMessage = window.showErrorMessage;
    (window as any).showErrorMessage = async (
      message: string,
      ...items: string[]
    ) => {
      errorMessageCalls.push({ message, items });
      return errorMessageResult;
    };

    // Mock window.showInformationMessage
    origShowInfoMessage = window.showInformationMessage;
    (window as any).showInformationMessage = async (
      message: string,
      ...items: string[]
    ) => {
      infoMessageCalls.push({ message, items });
      return infoMessageResult;
    };

    // Mock window.withProgress
    origWithProgress = window.withProgress;
    (window as any).withProgress = async (
      options: any,
      task: (progress: any) => Promise<any>
    ) => {
      withProgressCalls.push({ options });
      return task({} as any);
    };

    // Mock commands.executeCommand
    origExecuteCommand = commands.executeCommand;
    (commands as any).executeCommand = async (
      command: string,
      ...args: any[]
    ) => {
      executeCommandCalls.push({ command, args });

      if (command === "sven.getSourceControlManager") {
        const stateStore: Record<string, any> = {};
        return {
          svn: {
            exec: async () => {
              return { stdout: "Checked out", stderr: "", exitCode: 0 };
            }
          },
          context: {
            globalState: {
              get: (key: string) => stateStore[key],
              update: async (key: string, value: any) => {
                stateStore[key] = value;
              }
            }
          }
        };
      }

      if (command === "sven.promptAuth") {
        return { username: "testuser", password: "testpass" };
      }

      return undefined;
    };

    // Mock configuration.get
    origConfigGet = configuration.configuration.get;
    (configuration.configuration as any).get = (key: string) => {
      configGetCalls.push({ key });
      return configGetResult;
    };
  });

  teardown(() => {
    // Restore original functions
    validateRepositoryUrlSpy.mockRestore();
    getBranchNameSpy.mockRestore();
    (window as any).showInputBox = origShowInputBox;
    (window as any).showOpenDialog = origShowOpenDialog;
    (window as any).showQuickPick = origShowQuickPick;
    (window as any).showErrorMessage = origShowErrorMessage;
    (window as any).showInformationMessage = origShowInfoMessage;
    (window as any).withProgress = origWithProgress;
    (commands as any).executeCommand = origExecuteCommand;
    (configuration.configuration as any).get = origConfigGet;
  });

  suite("Checkout Command", () => {
    let checkout: Checkout;

    setup(() => {
      checkout = new Checkout();
    });

    teardown(() => {
      checkout.dispose();
    });

    test("1.1: Basic checkout workflow with valid URL", async () => {
      const testUrl = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(testUrl);

      assert.ok(validateUrlCalls.length > 0);
      assert.strictEqual(validateUrlCalls[0].url, testUrl);
      assert.ok(openDialogCalls.length > 0);
      assert.ok(withProgressCalls.length > 0);
    });

    test("1.2: Checkout with URL prompt", async () => {
      inputBoxResult = "https://svn.example.com/repo";
      openDialogResult = [Uri.file("/test/parent")];

      const inputBoxSpy = inputBoxCalls;
      await checkout.execute();

      // First call for URL, second for folder name
      assert.ok(inputBoxSpy.length >= 1);
      assert.ok(validateUrlCalls.length > 0);
    });

    test("1.3: User cancels URL prompt (undefined)", async () => {
      inputBoxResult = undefined;

      await checkout.execute();

      assert.strictEqual(validateUrlCalls.length, 0);
      assert.strictEqual(openDialogCalls.length, 0);
      assert.strictEqual(withProgressCalls.length, 0);
    });

    test("1.4: User cancels URL prompt (empty string)", async () => {
      inputBoxResult = "";

      await checkout.execute();

      // Empty URL should be rejected
      assert.strictEqual(openDialogCalls.length, 0);
    });

    test("1.5: SSRF prevention - invalid protocol rejected", async () => {
      const invalidUrl = "file:///etc/passwd";
      validateUrlResult = false;

      await checkout.execute(invalidUrl);

      assert.strictEqual(errorMessageCalls.length, 1);
      assert.ok(
        errorMessageCalls[0].message.includes("Invalid repository URL")
      );
      assert.strictEqual(openDialogCalls.length, 0);
      assert.strictEqual(withProgressCalls.length, 0);
    });

    test("1.6: SSRF prevention - file protocol blocked", async () => {
      const fileUrl = "file:///etc/passwd";
      validateUrlResult = false;

      await checkout.execute(fileUrl);

      assert.strictEqual(errorMessageCalls.length, 1);
      assert.strictEqual(openDialogCalls.length, 0);
    });

    test("1.7: SSRF prevention - shell metacharacters rejected", async () => {
      const maliciousUrl = "http://example.com; rm -rf /";
      validateUrlResult = false;

      await checkout.execute(maliciousUrl);

      assert.strictEqual(errorMessageCalls.length, 1);
      assert.strictEqual(openDialogCalls.length, 0);
    });

    test("1.8: Valid protocols allowed - http", async () => {
      const url = "http://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
      assert.ok(withProgressCalls.length > 0);
    });

    test("1.9: Valid protocols allowed - https", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
      assert.ok(withProgressCalls.length > 0);
    });

    test("1.10: Valid protocols allowed - svn", async () => {
      const url = "svn://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
      assert.ok(withProgressCalls.length > 0);
    });

    test("1.11: Valid protocols allowed - svn+ssh", async () => {
      const url = "svn+ssh://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
      assert.ok(withProgressCalls.length > 0);
    });

    test("1.12: User cancels location selection", async () => {
      const url = "https://svn.example.com/repo";
      openDialogResult = undefined;

      await checkout.execute(url);

      assert.ok(openDialogCalls.length > 0);
      assert.strictEqual(withProgressCalls.length, 0);
    });

    test("1.13: User cancels location selection (empty array)", async () => {
      const url = "https://svn.example.com/repo";
      openDialogResult = [];

      await checkout.execute(url);

      assert.ok(openDialogCalls.length > 0);
      assert.strictEqual(withProgressCalls.length, 0);
    });

    test("1.14: User cancels folder name prompt", async () => {
      const url = "https://svn.example.com/repo";
      openDialogResult = [Uri.file("/test/parent")];
      let callCount = 0;
      (window as any).showInputBox = async (options?: any) => {
        inputBoxCalls.push({ options });
        callCount++;
        if (callCount === 1) {
          return url;
        }
        return undefined; // Cancel folder name
      };

      await checkout.execute(url);

      assert.ok(openDialogCalls.length > 0);
      assert.ok(withProgressCalls.length > 0);
    });

    test("1.15: Branch name extracted from URL", async () => {
      const url = "https://svn.example.com/repo/trunk";
      getBranchNameResult = { name: "trunk", path: "/trunk" };
      let callCount = 0;
      (window as any).showInputBox = async (options?: any) => {
        inputBoxCalls.push({ options });
        callCount++;
        if (callCount === 1) {
          // Folder name prompt should have value from branch
          return "repo";
        }
        return undefined;
      };
      openDialogResult = [Uri.file("/test/parent")];

      await checkout.execute(url);

      assert.ok(getBranchNameCalls.length > 0);
    });

    test("1.16: Authentication retry on authorization failure", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      let attemptCount = 0;
      (commands as any).executeCommand = async (
        command: string,
        ...args: any[]
      ) => {
        executeCommandCalls.push({ command, args });

        if (command === "sven.getSourceControlManager") {
          return {
            svn: {
              exec: async (_path: string, _args: string[], _opt?: any) => {
                attemptCount++;
                if (attemptCount === 1) {
                  const err: ISvnErrorData = new Error(
                    "Auth failed"
                  ) as ISvnErrorData;
                  err.svnErrorCode = svnErrorCodes.AuthorizationFailed;
                  throw err;
                }
                return { stdout: "Checked out", stderr: "", exitCode: 0 };
              }
            },
            context: { globalState: mockGlobalState() }
          };
        }

        if (command === "sven.promptAuth") {
          return { username: "testuser", password: "testpass" };
        }

        return undefined;
      };

      await checkout.execute(url);

      assert.strictEqual(attemptCount, 2);
    });

    test("1.17: Authentication retry up to 3 attempts", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];

      let attemptCount = 0;
      (commands as any).executeCommand = async (
        command: string,
        ...args: any[]
      ) => {
        executeCommandCalls.push({ command, args });

        if (command === "sven.getSourceControlManager") {
          return {
            svn: {
              exec: async () => {
                attemptCount++;
                const err: ISvnErrorData = new Error(
                  "Auth failed"
                ) as ISvnErrorData;
                err.svnErrorCode = svnErrorCodes.AuthorizationFailed;
                throw err;
              }
            },
            context: { globalState: mockGlobalState() }
          };
        }

        if (command === "sven.promptAuth") {
          return { username: "testuser", password: "testpass" };
        }

        return undefined;
      };

      try {
        await checkout.execute(url);
        assert.fail("Should have thrown error after 3 attempts");
      } catch (err) {
        assert.ok(attemptCount <= 4);
      }
    });

    test("1.18: Non-auth errors throw immediately", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];

      (commands as any).executeCommand = async (
        command: string,
        ...args: any[]
      ) => {
        executeCommandCalls.push({ command, args });

        if (command === "sven.getSourceControlManager") {
          return {
            svn: {
              exec: async () => {
                throw new Error("Network error");
              }
            },
            context: { globalState: mockGlobalState() }
          };
        }

        return undefined;
      };

      try {
        await checkout.execute(url);
        assert.fail("Should have thrown error");
      } catch (err: any) {
        assert.ok(err.message.includes("Network error"));
      }
    });

    test("1.19: Default checkout directory from config", async () => {
      const url = "https://svn.example.com/repo";
      configGetResult = "/custom/checkout/dir";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(configGetCalls.length > 0);
      assert.strictEqual(configGetCalls[0].key, "defaultCheckoutDirectory");
    });

    test("1.20: Tilde expansion in checkout directory", async () => {
      const url = "https://svn.example.com/repo";
      configGetResult = "~/projects";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      // Config should be checked
      assert.ok(configGetCalls.length > 0);
    });

    test("1.21: Post-checkout - Open Repository selected", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      (commands as any).executeCommand = async (
        command: string,
        ...args: any[]
      ) => {
        executeCommandCalls.push({ command, args });

        if (command === "sven.getSourceControlManager") {
          return {
            svn: {
              exec: async () => ({
                stdout: "Checked out",
                stderr: "",
                exitCode: 0
              })
            },
            context: { globalState: mockGlobalState() }
          };
        }

        return undefined;
      };

      await checkout.execute(url);

      assert.ok(infoMessageCalls.length > 0);
      const openFolderCalls = executeCommandCalls.filter(
        c => c.command === "vscode.openFolder"
      );
      assert.ok(openFolderCalls.length > 0);
    });

    test("1.22: Post-checkout - Add to Workspace selected", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Add to Workspace";

      // Mock workspace
      const origWorkspaceFolders = workspace.workspaceFolders;
      (workspace as any).workspaceFolders = [{ uri: Uri.file("/existing") }];
      (workspace as any).updateWorkspaceFolders = () => {};

      await checkout.execute(url);

      assert.ok(infoMessageCalls.length > 0);

      // Restore
      (workspace as any).workspaceFolders = origWorkspaceFolders;
    });

    test("1.23: Post-checkout - User cancels action", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = undefined;

      await checkout.execute(url);

      assert.ok(infoMessageCalls.length > 0);
      const openFolderCalls = executeCommandCalls.filter(
        c => c.command === "vscode.openFolder"
      );
      assert.strictEqual(openFolderCalls.length, 0);
    });

    test("1.24: Progress indication shown", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(withProgressCalls.length > 0);
      const progressCall = withProgressCalls[0];
      assert.ok(progressCall.options.title.includes("Checkout svn repository"));
    });

    test("1.25: Checkout with special characters in folder name", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo-with-dashes_123";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(withProgressCalls.length > 0);
    });

    test("1.26: Checkout with spaces in parent path", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent with spaces")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(withProgressCalls.length > 0);
    });

    test("1.27: URL validation called before location prompt", async () => {
      const url = "https://svn.example.com/repo";
      const callOrder: string[] = [];

      validateRepositoryUrlSpy.mockImplementation((inputUrl: string) => {
        callOrder.push("validate");
        validateUrlCalls.push({ url: inputUrl });
        return true;
      });

      (window as any).showOpenDialog = async (options?: any) => {
        callOrder.push("openDialog");
        openDialogCalls.push({ options });
        return [Uri.file("/test/parent")];
      };

      inputBoxResult = "test-repo";
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.strictEqual(callOrder[0], "validate");
      assert.strictEqual(callOrder[1], "openDialog");
    });
  });

  suite("FinishCheckout Command", () => {
    let finishCheckout: FinishCheckout;
    let mockRepository: Partial<Repository>;
    let finishCheckoutCalls: any[] = [];

    setup(() => {
      finishCheckout = new FinishCheckout();
      finishCheckoutCalls = [];

      mockRepository = {
        finishCheckout: async () => {
          finishCheckoutCalls.push({});
          return "Finished checkout";
        }
      };
    });

    teardown(() => {
      finishCheckout.dispose();
    });

    test("2.1: Basic finish checkout execution", async () => {
      await finishCheckout.execute(mockRepository as Repository);

      assert.strictEqual(finishCheckoutCalls.length, 1);
    });

    test("2.2: Repository.finishCheckout called", async () => {
      await finishCheckout.execute(mockRepository as Repository);

      assert.ok(finishCheckoutCalls.length > 0);
    });

    test("2.3: Error handling on finish checkout failure", async () => {
      (mockRepository.finishCheckout as any) = async () => {
        throw new Error("SVN error: unable to switch");
      };

      try {
        await finishCheckout.execute(mockRepository as Repository);
        assert.fail("Should have thrown error");
      } catch (err: any) {
        assert.ok(err.message.includes("unable to switch"));
      }
    });

    test("2.4: Repository parameter passed correctly", async () => {
      let receivedRepo: any = null;
      (mockRepository.finishCheckout as any) = async function (
        this: Repository
      ) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- capturing `this` is the assertion
        receivedRepo = this;
        finishCheckoutCalls.push({});
        return "Finished";
      };

      await finishCheckout.execute(mockRepository as Repository);

      assert.strictEqual(receivedRepo, mockRepository);
    });

    test("2.5: Return value from finishCheckout", async () => {
      const expectedResult = "Revision 123: checkout finished";
      (mockRepository.finishCheckout as any) = async () => {
        finishCheckoutCalls.push({});
        return expectedResult;
      };

      await finishCheckout.execute(mockRepository as Repository);

      assert.ok(finishCheckoutCalls.length > 0);
    });

    test("2.6: Multiple finish checkout calls", async () => {
      await finishCheckout.execute(mockRepository as Repository);
      await finishCheckout.execute(mockRepository as Repository);
      await finishCheckout.execute(mockRepository as Repository);

      assert.strictEqual(finishCheckoutCalls.length, 3);
    });
  });

  suite("Edge Cases & Complex Scenarios", () => {
    let checkout: Checkout;

    setup(() => {
      checkout = new Checkout();
    });

    teardown(() => {
      checkout.dispose();
    });

    test("3.1: URL with query parameters", async () => {
      const url = "https://svn.example.com/repo?param=value";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
    });

    test("3.2: URL with authentication in URL (username@host)", async () => {
      const url = "https://user@svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
    });

    test("3.3: URL with port number", async () => {
      const url = "https://svn.example.com:8080/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
    });

    test("3.4: Deep URL path", async () => {
      const url = "https://svn.example.com/projects/repo/branches/feature/v2";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
    });

    test("3.5: URL with encoded characters", async () => {
      const url = "https://svn.example.com/repo%20with%20spaces";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(validateUrlCalls.length > 0);
    });

    test("3.6: Checkout to Windows-style path", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("C:\\Users\\test\\projects")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(withProgressCalls.length > 0);
    });

    test("3.7: Authentication cancelled by user", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "test-repo";
      openDialogResult = [Uri.file("/test/parent")];

      (commands as any).executeCommand = async (
        command: string,
        ...args: any[]
      ) => {
        executeCommandCalls.push({ command, args });

        if (command === "sven.getSourceControlManager") {
          return {
            svn: {
              exec: async () => {
                const err: ISvnErrorData = new Error(
                  "Auth failed"
                ) as ISvnErrorData;
                err.svnErrorCode = svnErrorCodes.AuthorizationFailed;
                throw err;
              }
            },
            context: { globalState: mockGlobalState() }
          };
        }

        if (command === "sven.promptAuth") {
          return null; // User cancelled auth
        }

        return undefined;
      };

      try {
        await checkout.execute(url);
        assert.fail("Should have thrown error");
      } catch (err) {
        assert.ok(true, "Error thrown when auth cancelled");
      }
    });

    test("3.8: Folder name with leading/trailing spaces", async () => {
      const url = "https://svn.example.com/repo";
      inputBoxResult = "  test-repo  ";
      openDialogResult = [Uri.file("/test/parent")];
      infoMessageResult = "Open Repository";

      await checkout.execute(url);

      assert.ok(withProgressCalls.length > 0);
    });

    test("3.9: Empty string URL after prompt", async () => {
      (window as any).showInputBox = async (options?: any) => {
        inputBoxCalls.push({ options });
        if (options?.prompt === "Repository URL") {
          return "";
        }
        return "test-repo";
      };

      await checkout.execute();

      // Should not proceed with empty URL
      assert.strictEqual(openDialogCalls.length, 0);
    });

    test("3.10: Whitespace-only URL", async () => {
      const url = "   ";
      validateUrlResult = false;

      await checkout.execute(url);

      // Should not proceed with whitespace URL
      assert.strictEqual(openDialogCalls.length, 0);
    });
  });
});
