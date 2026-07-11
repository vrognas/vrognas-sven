import * as assert from "assert";
import * as sinon from "sinon";
import { Uri } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";

function createEditor(uri: Uri): any {
  return {
    document: { uri, fsPath: uri.fsPath, lineCount: 1, version: 1 },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  };
}

suite("BlameProvider - active editor throttle", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(mockRepo as any);
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("does not pin the editor into the throttled render", async () => {
    // @throttle is not keep-last: a queued render keeps the FIRST queued
    // call's args. Pinning an explicit editor there renders a stale (maybe
    // off-screen) editor on rapid switching. Passing no arg lets the render
    // resolve window.activeTextEditor at execution time.
    const updateStub = sandbox
      .stub(provider as any, "updateDecorations")
      .resolves(undefined);

    await (provider as any).onActiveEditorChange(
      createEditor(Uri.file("/a.ts"))
    );

    assert.ok(updateStub.calledOnce);
    assert.strictEqual(
      updateStub.firstCall.args[0],
      undefined,
      "active-editor change must not pin an explicit editor"
    );
  });
});
