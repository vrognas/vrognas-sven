import * as assert from "assert";
import * as sinon from "sinon";
import { BlameStatusBar } from "../../../blame/blameStatusBar";

suite("BlameStatusBar - per-repo hook lifecycle", () => {
  test("releases a repository operation hook on close", () => {
    const operationDispose = sinon.stub();
    const repo = {
      onDidRunOperation: () => ({ dispose: operationDispose }),
      statusReady: Promise.resolve()
    };
    let openListener: ((repo: unknown) => void) | undefined;
    let closeListener: ((repo: unknown) => void) | undefined;
    const scm = {
      repositories: [],
      onDidOpenRepository: (listener: (repo: unknown) => void) => {
        openListener = listener;
        return { dispose() {} };
      },
      onDidCloseRepository: (listener: (repo: unknown) => void) => {
        closeListener = listener;
        return { dispose() {} };
      },
      getRepositoryFromUri: () => undefined
    };
    const statusBar = new BlameStatusBar(scm as never);
    try {
      openListener!(repo);
      assert.ok(
        closeListener,
        "status bar must subscribe to repository-close events"
      );

      closeListener!(repo);
      assert.ok(
        operationDispose.calledOnce,
        "repository close must release its operation hook"
      );
    } finally {
      statusBar.dispose();
    }
  });
});
