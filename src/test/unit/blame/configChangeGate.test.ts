import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { Repository } from "../../../repository";

function editorFor(path: string): any {
  const uri = Uri.file(path);
  return {
    document: { uri, lineCount: 10, version: 1, isClosed: false },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  };
}

suite("BlameProvider - config change gating", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    provider?.dispose();
    sandbox.restore();
    delete (window as any).visibleTextEditors;
  });

  test("non-visual config change skips the decoration teardown", async () => {
    const created: Array<{ dispose: sinon.SinonStub }> = [];
    sandbox.stub(window, "createTextEditorDecorationType").callsFake(() => {
      const t = { dispose: sandbox.stub() };
      created.push(t);
      return t as any;
    });

    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
    const baseCount = created.length; // 3 base types from the constructor
    sandbox.stub(provider as any, "updateDecorations").resolves(undefined);

    // Only a non-visual key changed (e.g. the CSV line limit).
    const event: any = {
      affectsConfiguration: (k: string) => k === "sven.blame.csvLineLimit"
    };
    await (provider as any).onConfigurationChange(event);

    assert.strictEqual(
      created.length,
      baseCount,
      "must not recreate decoration types for a non-visual config key"
    );
  });

  test("visual config change still tears down and recreates types", async () => {
    const created: Array<{ dispose: sinon.SinonStub }> = [];
    sandbox.stub(window, "createTextEditorDecorationType").callsFake(() => {
      const t = { dispose: sandbox.stub() };
      created.push(t);
      return t as any;
    });

    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
    const baseCount = created.length;
    sandbox.stub(provider as any, "updateDecorations").resolves(undefined);

    const event: any = {
      affectsConfiguration: (k: string) => k === "sven.blame.inline.template"
    };
    await (provider as any).onConfigurationChange(event);

    assert.ok(
      created.length > baseCount,
      "a visual key change must recreate the decoration types"
    );
  });

  test("gate config clears and rerenders every visible editor", async () => {
    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
    const active = editorFor("/test/active.csv");
    const inactive = editorFor("/test/inactive.csv");
    sandbox.stub(window, "activeTextEditor").value(active);
    (window as any).visibleTextEditors = [active, inactive];
    const clear = sandbox.stub(provider, "clearDecorations");
    const render = sandbox
      .stub(provider as any, "renderDecorations")
      .resolves(undefined);

    await (provider as any).onConfigurationChange({
      affectsConfiguration: (key: string) => key === "sven.blame.csvLineLimit"
    });

    assert.ok(clear.calledWith(active));
    assert.ok(clear.calledWith(inactive));
    assert.ok(render.calledWith(active));
    assert.ok(render.calledWith(inactive));
  });

  test("size gate clears decorations left by an earlier render", async () => {
    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
    const editor = editorFor("/test/large.csv");
    sandbox.stub(blameConfiguration, "getBlameSizeGate").returns("csv");
    sandbox.stub(window, "showWarningMessage").resolves(undefined);

    await provider.updateDecorations(editor);

    assert.ok(
      editor.setDecorations.called,
      "rejected render must remove prior decorations"
    );
    assert.ok(
      editor.setDecorations
        .getCalls()
        .every(
          (call: sinon.SinonSpyCall) =>
            Array.isArray(call.args[1]) && call.args[1].length === 0
        )
    );
  });
});
