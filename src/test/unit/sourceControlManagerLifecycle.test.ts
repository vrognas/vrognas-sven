import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";
import { Uri, workspace, WorkspaceFolder } from "vscode";
import { IOpenRepository } from "../../common/types";
import { SourceControlManager } from "../../source_control_manager";

suite("SourceControlManager workspace lifecycle", () => {
  let sandbox: sinon.SinonSandbox;
  const managers: SourceControlManager[] = [];

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    managers.forEach(manager => manager.dispose());
    managers.length = 0;
    sandbox.restore();
  });

  function folder(uri: Uri, name: string): WorkspaceFolder {
    return { uri, name, index: 0 };
  }

  function openRepository(root: Uri) {
    const manager = new SourceControlManager({} as never, {} as never);
    managers.push(manager);

    const repository = {
      workspaceRoot: root.fsPath,
      dispose: sandbox.spy()
    };
    const handleDispose = sandbox.spy(() => {
      repository.dispose();
      manager.openRepositories = manager.openRepositories.filter(
        candidate => candidate !== handle
      );
      (manager as any)._onDidCloseRepository.fire(repository);
    });
    const handle: IOpenRepository = {
      repository: repository as never,
      dispose: handleDispose
    };
    manager.openRepositories = [handle];

    return { manager, repository, handleDispose };
  }

  test("removed workspace uses the complete repository close path", () => {
    const removedUri = Uri.file("/workspace/removed");
    const { manager, repository, handleDispose } = openRepository(removedUri);
    const closed: unknown[] = [];
    manager.onDidCloseRepository(repo => closed.push(repo));
    sandbox.stub(workspace, "workspaceFolders").value([]);

    (manager as any).onDidChangeWorkspaceFolders({
      added: [],
      removed: [folder(removedUri, "removed")]
    });

    assert.strictEqual(handleDispose.callCount, 1);
    assert.strictEqual(repository.dispose.callCount, 1);
    assert.strictEqual(manager.openRepositories.length, 0);
    assert.deepStrictEqual(closed, [repository]);
  });

  test("remaining sibling prefix does not retain removed repository", () => {
    const remainingUri = Uri.file("/workspace/foo");
    const removedUri = Uri.file("/workspace/foobar");
    const { manager, handleDispose } = openRepository(removedUri);
    sandbox
      .stub(workspace, "workspaceFolders")
      .value([folder(remainingUri, "foo")]);

    (manager as any).onDidChangeWorkspaceFolders({
      added: [],
      removed: [folder(removedUri, "foobar")]
    });

    assert.strictEqual(handleDispose.callCount, 1);
    assert.strictEqual(manager.openRepositories.length, 0);
  });

  test("removing a workspace closes every nested open repository", () => {
    const removedUri = Uri.file("/workspace");
    const { manager, handleDispose } = openRepository(removedUri);
    const nestedDispose = sandbox.spy();
    const nested = {
      repository: {
        workspaceRoot: Uri.file("/workspace/nested").fsPath,
        dispose: sandbox.spy()
      },
      dispose: nestedDispose
    };
    manager.openRepositories.push(nested as never);
    sandbox.stub(workspace, "workspaceFolders").value([]);

    (manager as any).onDidChangeWorkspaceFolders({
      added: [],
      removed: [folder(removedUri, "workspace")]
    });

    assert.strictEqual(handleDispose.callCount, 1);
    assert.strictEqual(nestedDispose.callCount, 1);
  });

  test("parent-to-child workspace replacement rescans after close", () => {
    const parentUri = Uri.file("/workspace");
    const childUri = Uri.file("/workspace/child");
    const { manager, handleDispose } = openRepository(parentUri);
    const tryOpen = sandbox
      .stub(manager, "tryOpenRepository")
      .resolves(undefined);
    sandbox
      .stub(workspace, "workspaceFolders")
      .value([folder(childUri, "child")]);

    (manager as any).onDidChangeWorkspaceFolders({
      added: [folder(childUri, "child")],
      removed: [folder(parentUri, "parent")]
    });

    assert.strictEqual(handleDispose.callCount, 1);
    assert.ok(tryOpen.calledOnceWith(childUri.fsPath));
  });

  test("removed workspace fences an in-flight repository open", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sven-open-race-"));
    fs.mkdirSync(path.join(root, ".svn"));
    const rootUri = Uri.file(root);
    let folders: WorkspaceFolder[] = [folder(rootUri, "race")];
    sandbox.stub(workspace, "workspaceFolders").get(() => folders);
    let resolveRoot!: (value: { root: string; info: object }) => void;
    const rootReady = new Promise<{ root: string; info: object }>(resolve => {
      resolveRoot = resolve;
    });
    const svn = {
      getRepositoryRoot: sandbox.stub().returns(rootReady),
      open: sandbox.stub().rejects(new Error("stale open"))
    };
    const manager = new SourceControlManager(svn as never, {} as never);
    managers.push(manager);

    try {
      const pending = manager.tryOpenRepository(root);
      for (let i = 0; i < 20 && svn.getRepositoryRoot.callCount === 0; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.strictEqual(svn.getRepositoryRoot.callCount, 1);
      folders = [];
      (manager as any).onDidChangeWorkspaceFolders({
        added: [],
        removed: [folder(rootUri, "race")]
      });
      resolveRoot({ root, info: {} });

      await pending;

      assert.strictEqual(svn.open.callCount, 0);
      assert.strictEqual(manager.openRepositories.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
