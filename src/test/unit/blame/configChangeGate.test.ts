import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";

suite("BlameProvider - config change gating", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    provider?.dispose();
    sandbox.restore();
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
});
