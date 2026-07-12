import { scmFor } from "./helpers/blameScm";
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

suite("BlameProvider - active editor repo scheduler", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("lets the no-arg scheduler resolve the live active repo", async () => {
    // Active events use the no-arg per-repo scheduler. Explicit editor calls
    // remain reserved for lossless URI/lifecycle work.
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
      "active-editor change must select the live repo"
    );
  });
});
