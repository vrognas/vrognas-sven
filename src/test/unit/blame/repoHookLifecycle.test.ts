import * as assert from "assert";
import * as sinon from "sinon";
import { BlameProvider } from "../../../blame/blameProvider";

suite("BlameProvider - per-repo hook lifecycle", () => {
  let sandbox: sinon.SinonSandbox;
  let provider: BlameProvider;

  setup(() => (sandbox = sinon.createSandbox()));
  teardown(() => {
    provider?.dispose();
    sandbox.restore();
  });

  test("releases a repo's operation subscription when it closes", () => {
    const opDispose = sinon.stub();
    const repo = {
      workspaceRoot: "/ws",
      onDidRunOperation: () => ({ dispose: opDispose })
    };
    let openCb: ((r: unknown) => void) | undefined;
    let closeCb: ((r: unknown) => void) | undefined;
    const scm = {
      repositories: [],
      onDidOpenRepository: (cb: (r: unknown) => void) => {
        openCb = cb;
        return { dispose() {} };
      },
      onDidCloseRepository: (cb: (r: unknown) => void) => {
        closeCb = cb;
        return { dispose() {} };
      },
      getRepositoryFromUri: () => undefined
    };
    provider = new BlameProvider(scm as never);
    provider.activate();

    openCb!(repo); // hooks onDidRunOperation
    assert.ok(opDispose.notCalled);

    assert.ok(closeCb, "provider must subscribe to onDidCloseRepository");
    closeCb!(repo); // repo closes

    assert.ok(
      opDispose.calledOnce,
      "closing a repo must dispose its per-repo hooks (no leak)"
    );
  });
});
