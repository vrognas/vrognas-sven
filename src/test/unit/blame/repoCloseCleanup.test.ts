import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { Operation } from "../../../common/types";

function createEditor(uri: Uri): any {
  return {
    document: { uri, fsPath: uri.fsPath, lineCount: 1, version: 1 },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  };
}

suite("BlameProvider - repo close cleanup + scoped invalidation", () => {
  let sandbox: sinon.SinonSandbox;
  let provider: BlameProvider;

  setup(() => (sandbox = sinon.createSandbox()));
  teardown(() => {
    provider?.dispose();
    sandbox.restore();
    delete (window as any).visibleTextEditors;
  });

  test("closing a repo clears its blame/message caches and decorations", () => {
    const repo = { workspaceRoot: "/ws" };
    let closeCb: ((r: unknown) => void) | undefined;
    const scm = {
      repositories: [],
      onDidOpenRepository: () => ({ dispose() {} }),
      onDidCloseRepository: (cb: (r: unknown) => void) => {
        closeCb = cb;
        return { dispose() {} };
      },
      getRepositoryFromUri: () => null // repo already deregistered on close
    };
    provider = new BlameProvider(scm as never);
    provider.activate();

    const uri = Uri.file("/ws/file.ts");
    const p = provider as any;
    p.blameCache.set(uri.toString(), { data: [], version: 1 });
    p.messageCache.set(p.msgKey("/ws", "42"), "msg");

    const editor = createEditor(uri);
    (window as any).visibleTextEditors = [editor];
    const clearStub = sandbox.stub(p, "clearDecorations");

    closeCb!(repo);

    assert.ok(!p.blameCache.has(uri.toString()), "blame cache cleared");
    assert.ok(
      !p.messageCache.has(p.msgKey("/ws", "42")),
      "message cache cleared"
    );
    assert.ok(
      clearStub.calledWith(editor),
      "decorations cleared on the closed repo's visible editor"
    );
  });

  test("a parent-repo op does not clear a nested repo's caches", () => {
    const parent = { workspaceRoot: "/wc" };
    const clearNested = sandbox.stub();
    const nested = {
      workspaceRoot: "/wc/nested",
      repository: { clearBlameCache: clearNested }
    };
    const nestedUri = Uri.file("/wc/nested/file.ts");
    const scm = {
      repositories: [parent, nested],
      onDidOpenRepository: () => ({ dispose() {} }),
      onDidCloseRepository: () => ({ dispose() {} }),
      // Deepest-owner resolution: a nested file resolves to the nested repo.
      getRepositoryFromUri: (uri: Uri) =>
        uri.path.startsWith("/wc/nested")
          ? nested
          : uri.path.startsWith("/wc")
            ? parent
            : null
    };
    provider = new BlameProvider(scm as never);
    provider.activate();

    const p = provider as any;
    p.blameCache.set(nestedUri.toString(), { data: [], version: 1 });
    sandbox.stub(window, "activeTextEditor").value(undefined);

    p.onRepositoryOperation(Operation.Commit, parent);

    assert.ok(
      p.blameCache.has(nestedUri.toString()),
      "nested repo's cache must survive a commit in the parent repo"
    );
    assert.ok(clearNested.notCalled, "nested lower cache must survive commit");
  });

  test("a parent update invalidates opened nested repositories", () => {
    const parent = { workspaceRoot: "/wc" };
    const clearNested = sandbox.stub();
    const nested = {
      workspaceRoot: "/wc/nested",
      repository: { clearBlameCache: clearNested }
    };
    const nestedUri = Uri.file("/wc/nested/file.ts");
    const scm = {
      repositories: [parent, nested],
      onDidOpenRepository: () => ({ dispose() {} }),
      onDidCloseRepository: () => ({ dispose() {} }),
      getRepositoryFromUri: (uri: Uri) =>
        uri.path.startsWith("/wc/nested")
          ? nested
          : uri.path.startsWith("/wc")
            ? parent
            : null
    };
    provider = new BlameProvider(scm as never);
    provider.activate();

    const p = provider as any;
    p.blameCache.set(nestedUri.toString(), { data: [], version: 1 });
    sandbox.stub(window, "activeTextEditor").value(undefined);

    p.onRepositoryOperation(Operation.Update, parent);

    assert.ok(!p.blameCache.has(nestedUri.toString()));
    assert.ok(clearNested.calledOnce, "nested lower cache cleared");
  });

  test("closing a parent preserves a still-open nested repo", () => {
    const parent = { workspaceRoot: "/wc" };
    const nested = { workspaceRoot: "/wc/nested" };
    let closeCb: ((r: unknown) => void) | undefined;
    const scm = {
      repositories: [nested],
      onDidOpenRepository: () => ({ dispose() {} }),
      onDidCloseRepository: (cb: (r: unknown) => void) => {
        closeCb = cb;
        return { dispose() {} };
      },
      getRepositoryFromUri: (uri: Uri) =>
        uri.path.startsWith("/wc/nested") ? nested : null
    };
    provider = new BlameProvider(scm as never);
    provider.activate();

    const uri = Uri.file("/wc/nested/file.ts");
    const editor = createEditor(uri);
    const p = provider as any;
    p.blameCache.set(uri.toString(), { data: [], version: 1 });
    (window as any).visibleTextEditors = [editor];
    const clear = sandbox.stub(p, "clearDecorations");

    closeCb!(parent);

    assert.ok(p.blameCache.has(uri.toString()));
    assert.ok(clear.notCalled, "nested editor remains decorated");
  });
});
