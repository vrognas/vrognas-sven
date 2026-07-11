import * as assert from "assert";
import * as sinon from "sinon";
import { Uri } from "vscode";
import { BlameStatusBar } from "../../../blame/blameStatusBar";
import { SourceControlManager } from "../../../source_control_manager";
import { ISvnBlameLine } from "../../../common/types";

suite("BlameStatusBar - initial status crawl", () => {
  let statusBar: BlameStatusBar;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    statusBar?.dispose();
    sandbox.restore();
  });

  test("does not block blame lookup on the initial status crawl", async () => {
    const uri = Uri.file("/test/file.ts");
    const blame: ISvnBlameLine[] = [
      { lineNumber: 1, revision: "1", author: "a", date: "2026-01-01" }
    ];
    const repo = {
      root: "/test",
      workspaceRoot: "/test",
      statusReady: new Promise<void>(() => {}), // never resolves (crawl in progress)
      getResourceFromFile: sandbox.stub().returns(undefined),
      isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined),
      blame: sandbox.stub().resolves(blame)
    };
    const scm = sandbox.createStubInstance(SourceControlManager);
    (scm as any).openRepositories = [];
    scm.getRepository.returns(repo as any);

    statusBar = new BlameStatusBar(scm as any);

    const result = await Promise.race([
      (statusBar as any).getBlameData(uri),
      new Promise(resolve => setTimeout(() => resolve("TIMEOUT"), 150))
    ]);

    assert.notStrictEqual(
      result,
      "TIMEOUT",
      "getBlameData must not await the initial status crawl"
    );
    assert.ok(repo.blame.called, "blame is attempted immediately");
  });
});
