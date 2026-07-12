import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { blameStateManager } from "../../../blame/blameStateManager";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

suite("BlameProvider - render cache vs message activity", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    provider?.dispose();
    sandbox.restore();
  });

  test("unrelated message fetch does not invalidate a file's render cache", async () => {
    const uri = Uri.file("/test/epoch.ts");
    const blame: ISvnBlameLine[] = [
      { lineNumber: 1, revision: "100", author: "a", date: "2026-01-01" }
    ];

    const mockRepository = sandbox.createStubInstance(Repository);
    (mockRepository as any).repository = {
      workspaceRoot: "/test",
      root: "/test"
    };
    (mockRepository as any).statusReady = Promise.resolve();
    mockRepository.blame.resolves(blame);
    mockRepository.log.resolves([
      { revision: "777", author: "z", date: "2026-01-01", msg: "x", paths: [] }
    ] as any);
    mockRepository.getResourceFromFile.returns(undefined as any);

    provider = new BlameProvider(scmFor(mockRepository as any));

    sandbox.stub(blameConfiguration, "isEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterIconEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(false);
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(false);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(true);
    sandbox.stub(blameStateManager, "shouldShowBlame").returns(true);

    const editor: any = {
      document: {
        uri,
        fsPath: uri.fsPath,
        lineCount: 1,
        version: 1,
        lineAt: () => ({ range: { end: { character: 5 } } })
      },
      selection: { active: { line: 0 } },
      setDecorations: sandbox.stub()
    };
    sandbox.stub(window, "activeTextEditor").value(editor);

    // Pin the add-revision marker so it can't change between renders and
    // confound this test (its own invalidation is a separate concern).
    (provider as any).addRevisionCache.set(uri.toString(), "1");

    const buildSpy = sandbox.spy(provider as any, "createAllDecorations");

    await provider.updateDecorations(editor); // miss → builds
    // Simulate an unrelated file's commit message landing.
    await (provider as any).getCommitMessage("777");
    await provider.updateDecorations(editor); // same version → must reuse

    assert.strictEqual(
      buildSpy.callCount,
      1,
      "second render at the same version must reuse the cache despite message activity"
    );
  });
});
