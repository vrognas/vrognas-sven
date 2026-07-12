import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

function createEditor(uri: Uri, lineCount = 3, version = 1): any {
  return {
    document: { uri, lineCount, version, fsPath: uri.fsPath },
    selection: { active: { line: 0 } },
    setDecorations: sinon.stub()
  };
}

const BLAME: ISvnBlameLine[] = [
  { lineNumber: 1, revision: "100", author: "a", date: "2026-01-01" },
  { lineNumber: 2, revision: "100", author: "a", date: "2026-01-01" },
  { lineNumber: 3, revision: "50", author: "b", date: "2026-01-01" }
];
const RANGE = { min: 50, max: 100, uniqueRevisions: [100, 50] };

suite("BlameProvider - icon type reuse", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    provider?.dispose();
    sandbox.restore();
  });

  test("reuses icon decoration types across identical re-renders", () => {
    const created: Array<{ dispose: sinon.SinonStub }> = [];
    sandbox.stub(window, "createTextEditorDecorationType").callsFake(() => {
      const t = { dispose: sandbox.stub() };
      created.push(t);
      return t as any;
    });

    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
    const base = created.length; // 3 base types from the constructor
    const editor = createEditor(Uri.file("/test/icons.ts"));

    (provider as any).applyIconDecorations(editor, BLAME, RANGE, undefined);
    const afterFirst = created.length;
    const iconTypes = created.slice(base);
    assert.ok(
      iconTypes.length >= 2,
      "two colors → two icon types on first render"
    );

    (provider as any).applyIconDecorations(editor, BLAME, RANGE, undefined);

    assert.strictEqual(
      created.length,
      afterFirst,
      "identical re-render must not create new icon types"
    );
    for (const t of iconTypes) {
      assert.ok(
        t.dispose.notCalled,
        "icon types must not be disposed on re-render"
      );
    }
  });

  test("clearDecorations keeps icon types alive for reuse", () => {
    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
    const editor = createEditor(Uri.file("/test/icons2.ts"));

    const iconType = { dispose: sandbox.stub() };
    (provider as any).iconTypes.set("#abc123", iconType);

    (provider as any).clearDecorations(editor);

    assert.ok(
      iconType.dispose.notCalled,
      "clearDecorations must not dispose icon types"
    );
    assert.ok(
      (provider as any).iconTypes.has("#abc123"),
      "icon types retained for reuse"
    );
    assert.ok(
      editor.setDecorations.called,
      "decorations still visually cleared"
    );
  });
});
