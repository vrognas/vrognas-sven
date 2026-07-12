import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

const BLAME_DATA: ISvnBlameLine[] = [
  {
    lineNumber: 1,
    revision: "100",
    author: "alice",
    date: "2025-01-01T00:00:00Z"
  }
];

function makeEditor(uri: Uri, version: number) {
  return {
    document: {
      uri,
      version,
      lineCount: 1,
      lineAt: (_i: number) => ({ range: { end: { character: 10 } } })
    },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  } as any;
}

suite("BlameProvider cache versioning", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    (mockRepository as any).repository = {
      workspaceRoot: "/test",
      root: "/test"
    };
    mockRepository.blame.resolves(BLAME_DATA);
    provider = new BlameProvider(scmFor(mockRepository as any));
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("cache hits for non-active editors (version from event editor)", async () => {
    const uriA = Uri.file("/test/a.txt");
    const editorA = makeEditor(uriA, 1);

    // A different file is focused - fileA is a visible non-active pane
    const editorB = makeEditor(Uri.file("/test/b.txt"), 1);
    sandbox.stub(window, "activeTextEditor").value(editorB);

    await (provider as any).getBlameData(uriA, editorA);
    await (provider as any).getBlameData(uriA, editorA);

    assert.strictEqual(
      mockRepository.blame.callCount,
      1,
      "second lookup for an unchanged non-active document must hit the cache"
    );
  });

  test("version bump invalidates cache (external change detection)", async () => {
    const uriA = Uri.file("/test/a.txt");
    const editorA = makeEditor(uriA, 1);
    sandbox.stub(window, "activeTextEditor").value(editorA);

    await (provider as any).getBlameData(uriA, editorA);
    editorA.document.version = 2; // reload after svn update / edit
    await (provider as any).getBlameData(uriA, editorA);

    assert.strictEqual(
      mockRepository.blame.callCount,
      2,
      "document version change must invalidate the provider cache"
    );
  });
});
