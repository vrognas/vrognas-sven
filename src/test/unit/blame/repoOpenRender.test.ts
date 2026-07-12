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

    const updateStub = sandbox
      .stub(provider as any, "updateDecorations")
      .resolves(undefined);

    provider.activate();
    updateStub.resetHistory(); // ignore activate()'s own initial render

    openCb!(repo); // repo discovered later

    assert.ok(
      updateStub.called,
      "opening the active file's repo must trigger an immediate render"
    );
    assert.strictEqual(updateStub.firstCall.args[0], editor);
  });
});
