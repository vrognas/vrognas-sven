import * as assert from "assert";
import * as sinon from "sinon";
import { Uri } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

function createEditor(uri: Uri, lineCount = 3): any {
  return {
    document: {
      uri,
      lineCount,
      version: 1,
      fsPath: uri.fsPath,
      lineAt: () => ({ range: { end: { character: 5 } } })
    },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  };
}

suite("BlameProvider - progressive inline build", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    const mockRepo = sandbox.createStubInstance(Repository);
    (mockRepo as any).repository = { workspaceRoot: "/test", root: "/test" };
    provider = new BlameProvider(mockRepo as any);
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("skips per-line message fetch and inline build on the progressive path", async () => {
    // Progressive path (skipMessagePrefetch) with messages enabled: the
    // inline array is discarded (Phase 2 rebuilds via logBatch), so building
    // it here — one svn log per line — is pure waste.
    sandbox.stub(blameConfiguration, "isInlineEnabled").returns(true);
    sandbox.stub(blameConfiguration, "shouldShowInlineMessage").returns(true);
    sandbox.stub(blameConfiguration, "isInlineCurrentLineOnly").returns(false);
    sandbox.stub(blameConfiguration, "isGutterEnabled").returns(true);
    sandbox.stub(blameConfiguration, "isGutterTextEnabled").returns(true);
    sandbox.stub(blameConfiguration, "getGutterTemplate").returns("${author}");
    sandbox.stub(blameConfiguration, "getDateFormat").returns("relative");
    sandbox.stub(blameConfiguration, "getInlineOpacity").returns(0.5);
    const msgStub = sandbox
      .stub(provider as any, "getCommitMessage")
      .resolves("msg");

    const blame: ISvnBlameLine[] = [
      { lineNumber: 1, revision: "100", author: "a", date: "2026-01-01" },
      { lineNumber: 2, revision: "101", author: "b", date: "2026-01-01" }
    ];

    const decorations = await (provider as any).createAllDecorations(
      blame,
      createEditor(Uri.file("/test/prog.ts")),
      { skipMessagePrefetch: true }
    );

    assert.ok(
      msgStub.notCalled,
      "no per-line getCommitMessage on the progressive path"
    );
    assert.strictEqual(
      decorations.inline.length,
      0,
      "inline is rebuilt in Phase 2 — don't build a discarded copy"
    );
    assert.strictEqual(decorations.gutter.length, 2, "gutter still built");
  });
});
