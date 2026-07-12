import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";

function createEditor(uri: Uri): any {
  return {
    document: { uri, fsPath: uri.fsPath, lineCount: 1, version: 1 },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  };
}

suite("BlameProvider - render on repo open", () => {
  let sandbox: sinon.SinonSandbox;
  let provider: BlameProvider;

  setup(() => (sandbox = sinon.createSandbox()));
  teardown(() => {
    provider?.dispose();
    sandbox.restore();
    delete (window as any).visibleTextEditors;
  });

  test("renders the active editor immediately when its repo opens", async () => {
    // Repos are discovered asynchronously AFTER activate(), so the shared
    // provider must paint the already-open file when its repo opens instead
    // of waiting for the initial status crawl (statusReady).
    const repo = { workspaceRoot: "/ws" };
    let openCb: ((r: unknown) => void) | undefined;
    const scm = {
      repositories: [], // none open yet at activate()
      onDidOpenRepository: (cb: (r: unknown) => void) => {
        openCb = cb;
        return { dispose() {} };
      },
      getRepositoryFromUri: () => repo
    };
    provider = new BlameProvider(scm as never);

    const editor = createEditor(Uri.file("/ws/file.ts"));
    sandbox.stub(window, "activeTextEditor").value(editor);

    const renderStub = sandbox
      .stub(provider as any, "renderDecorations")
      .resolves(undefined);

    provider.activate();
    renderStub.resetHistory(); // ignore activate()'s own initial render

    openCb!(repo); // repo discovered later

    assert.ok(
      renderStub.calledWith(editor),
      "opening the active file's repo must trigger an immediate render"
    );
  });

  test("status ready invalidates and rerenders every visible owned editor", async () => {
    let resolveStatus!: () => void;
    const statusReady = new Promise<void>(resolve => (resolveStatus = resolve));
    const repo = { workspaceRoot: "/ws", statusReady };
    const scm = {
      repositories: [repo],
      getRepositoryFromUri: () => repo
    };
    provider = new BlameProvider(scm as never);

    const active = createEditor(Uri.file("/ws/active.ts"));
    const inactive = createEditor(Uri.file("/ws/inactive.ts"));
    sandbox.stub(window, "activeTextEditor").value(active);
    (window as any).visibleTextEditors = [active, inactive];
    const clear = sandbox.stub(provider, "clearCache");
    const render = sandbox
      .stub(provider as any, "renderDecorations")
      .resolves(undefined);

    provider.activate();
    clear.resetHistory();
    render.resetHistory();
    resolveStatus();
    await statusReady;
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(clear.calledWith(active.document.uri));
    assert.ok(clear.calledWith(inactive.document.uri));
    assert.ok(render.calledWith(active));
    assert.ok(render.calledWith(inactive));
  });

  test("bulk render skips an editor hidden while an earlier render waits", async () => {
    let resolveStatus!: () => void;
    const statusReady = new Promise<void>(resolve => (resolveStatus = resolve));
    const repo = { workspaceRoot: "/ws", statusReady };
    provider = new BlameProvider({
      repositories: [repo],
      getRepositoryFromUri: () => repo
    } as never);
    const first = createEditor(Uri.file("/ws/first.ts"));
    const hidden = createEditor(Uri.file("/ws/hidden.ts"));
    const last = createEditor(Uri.file("/ws/last.ts"));
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>(resolve => (releaseFirst = resolve));
    sandbox.stub(window, "activeTextEditor").value(first);
    (window as any).visibleTextEditors = [first, hidden, last];
    const render = sandbox.stub(provider as any, "renderDecorations");
    render.callsFake((editor: any) =>
      editor === first ? firstPending : Promise.resolve()
    );

    provider.activate();
    render.resetHistory();
    resolveStatus();
    await statusReady;
    await Promise.resolve();
    (window as any).visibleTextEditors = [first, last];
    hidden.document.isClosed = true;
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(render.calledWith(first));
    assert.ok(!render.calledWith(hidden), "dead editor must be skipped");
    assert.ok(render.calledWith(last), "later live editor still renders");
  });
});
