import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { Repository } from "../../../repository";
import { Operation, RepositoryState } from "../../../common/types";
import { ISvnBlameLine } from "../../../common/types";

const BLAME_DATA: ISvnBlameLine[] = [
  {
    lineNumber: 1,
    revision: "100",
    author: "alice",
    date: "2025-01-01T00:00:00Z"
  }
];

suite("Blame redundant call elimination", () => {
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
    provider = new BlameProvider(scmFor(mockRepository as any));
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("getBlameData blames without an svn info pre-check", async () => {
    const uri = Uri.file("/test/clean.ts");
    const editor = {
      document: { uri, version: 1 }
    } as any;
    mockRepository.getResourceFromFile.returns(undefined as any);
    mockRepository.blame.resolves(BLAME_DATA);

    const result = await (provider as any).getBlameData(uri, editor);

    assert.deepStrictEqual(result, BLAME_DATA);
    assert.ok(
      mockRepository.getInfo.notCalled,
      "clean files must not pay an svn info subprocess before blame"
    );
    assert.ok(mockRepository.blame.calledOnce);
  });

  test("prefetchMessages targets logBatch at the blamed file", async () => {
    const uri = Uri.file("/test/file.ts");
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    mockRepository.logBatch.resolves([
      { revision: "100", msg: "hello" }
    ] as any);

    await (provider as any).prefetchMessages(["100"], uri);

    assert.ok(mockRepository.logBatch.calledOnce);
    assert.strictEqual(
      mockRepository.logBatch.firstCall.args[1],
      uri.fsPath,
      "logBatch without a target spans the whole checkout history"
    );
  });

  test("message fallback stays untargeted (survives replaced paths)", async () => {
    const uri = Uri.file("/test/file.ts");
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);
    // Targeted range log can fail when blame revisions belong to a
    // replaced/renamed ancestor path - the per-revision fallback must not
    // repeat the same targeted query
    mockRepository.logBatch.rejects(new Error("E160013: path not found"));
    mockRepository.log.resolves([{ revision: "100", msg: "m" }] as any);

    await (provider as any).prefetchMessages(["100"], uri);

    assert.ok(mockRepository.log.calledOnce);
    assert.strictEqual(
      mockRepository.log.firstCall.args[3],
      undefined,
      "single-revision fallback log must be untargeted"
    );
  });

  test("blame and list ops skip the SCM progress spinner", async () => {
    const mockThis: any = {
      state: RepositoryState.Idle,
      repository: { clearBlameCache: () => {} },
      _operations: { start: () => {}, end: () => {} },
      _onRunOperation: { fire: () => {} },
      _onDidRunOperation: { fire: () => {} },
      retryRun: async (fn: () => Promise<unknown>) => fn(),
      updateModelState: async () => {},
      lastForceRefresh: 0
    };
    const run = (Repository.prototype as any).run;
    const withProgress = window.withProgress as unknown as {
      mockClear: () => void;
      mock: { calls: unknown[] };
    };

    withProgress.mockClear();
    await run.call(mockThis, Operation.Blame, async () => "ok");
    await run.call(mockThis, Operation.List, async () => "ok");
    assert.strictEqual(
      withProgress.mock.calls.length,
      0,
      "background blame/list reads must not flash the SCM spinner"
    );

    await run.call(mockThis, Operation.Commit, async () => "ok");
    assert.strictEqual(
      withProgress.mock.calls.length,
      1,
      "mutating ops keep the progress UI"
    );
  });
});
