import * as assert from "assert";
import { commands, Disposable, Uri } from "vscode";
import { vi } from "vitest";
import { SourceControlManager } from "../../../source_control_manager";
import { SvnFinder } from "../../../svnFinder";

const blameActions = vi.hoisted(() => ({
  showDiff: vi.fn(),
  peekChanges: vi.fn(),
  peekLineHistory: vi.fn()
}));

vi.mock("../../../blame/blameDiff", () => ({
  openBlameRevisionDiff: blameActions.showDiff
}));
vi.mock("../../../blame/blamePeek", () => ({
  peekLatestChange: blameActions.peekChanges,
  peekLineHistory: blameActions.peekLineHistory,
  blamePeekLinkProvider: {}
}));

suite("Blame command repository resolution", () => {
  test("external-file commands use descendant ownership", async () => {
    const event = (
      _listener: (...args: any[]) => unknown,
      _thisArg?: unknown,
      disposables?: Disposable[]
    ) => {
      const disposable = new Disposable(() => undefined);
      disposables?.push(disposable);
      return disposable;
    };
    const remoteRepository = {};
    const owner = { repository: remoteRepository };
    const getRepository = vi.fn(() => null);
    const getRepositoryFromUri = vi.fn(() => owner);
    const scm = {
      repositories: [],
      openRepositories: [],
      getRepository,
      getRepositoryFromUri,
      onDidOpenRepository: event,
      onDidCloseRepository: event,
      onDidChangeRepository: event,
      onDidChangeStatusRepository: event,
      svn: { exec: vi.fn() },
      context: {},
      dispose: vi.fn()
    };
    const subscriptions: Disposable[] = [];
    const context: any = {
      subscriptions,
      extensionPath: process.cwd(),
      globalState: { get: vi.fn(), update: vi.fn() },
      workspaceState: { get: vi.fn(), update: vi.fn() },
      secrets: {
        get: vi.fn(),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: event
      }
    };
    vi.spyOn(SvnFinder.prototype, "findSvn").mockResolvedValue({
      path: "svn",
      version: "1.14.0"
    });
    vi.spyOn(SourceControlManager, "create").mockResolvedValue(scm as any);

    const { activate } = await import("../../../extension");
    await activate(context);
    const uri = Uri.file("/workspace/external/file.ts");

    await commands.executeCommand("sven.blame.showDiff", uri.toString(), "7");
    await commands.executeCommand(
      "sven.blame.peekChanges",
      uri.toString(),
      "7",
      1,
      0
    );
    await commands.executeCommand(
      "sven.blame.peekLineHistory",
      uri.toString(),
      1,
      0
    );

    try {
      assert.strictEqual(getRepository.mock.calls.length, 0);
      assert.strictEqual(getRepositoryFromUri.mock.calls.length, 3);
      assert.ok(blameActions.showDiff.mock.calls.length === 1);
      assert.ok(blameActions.peekChanges.mock.calls.length === 1);
      assert.ok(blameActions.peekLineHistory.mock.calls.length === 1);
      assert.strictEqual(
        blameActions.showDiff.mock.calls[0]![0],
        remoteRepository
      );
    } finally {
      subscriptions.forEach(disposable => disposable.dispose());
      vi.restoreAllMocks();
    }
  });
});
