import * as assert from "assert";
const cp = require("child_process") as typeof import("child_process");
import { EventEmitter } from "events";
import * as sinon from "sinon";
import { Svn } from "../../../svn";
import SvnError from "../../../svnError";

class MockProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = sinon.spy();
}

suite("Svn process lifecycle", () => {
  let svn: Svn;
  let spawnStub: sinon.SinonStub;
  let child: MockProcess;

  setup(() => {
    svn = new Svn({ svnPath: "svn", version: "1.14.0" });
    child = new MockProcess();
    spawnStub = sinon.stub(cp, "spawn").returns(child as never);
  });

  teardown(() => {
    spawnStub.restore();
    svn.dispose();
  });

  function emitResult(exitCode: number, stdout = "", stderr = ""): void {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.stdout.emit("close");
      child.stderr.emit("close");
      child.emit("exit", exitCode);
    });
  }

  function assertProcessListenersDisposed(): void {
    assert.strictEqual(child.listenerCount("error"), 0);
    assert.strictEqual(child.listenerCount("exit"), 0);
    assert.strictEqual(child.stdout.listenerCount("data"), 0);
    assert.strictEqual(child.stdout.listenerCount("close"), 0);
    assert.strictEqual(child.stderr.listenerCount("data"), 0);
    assert.strictEqual(child.stderr.listenerCount("close"), 0);
  }

  test("execBuffer rejects nonzero exit with SvnError details", async () => {
    emitResult(1, "partial output", "svn: E175002: connection timed out");

    await assert.rejects(
      svn.execBuffer("/repo", ["cat", "file.txt"], { log: false }),
      (error: unknown) => {
        assert.ok(error instanceof SvnError);
        assert.strictEqual(error.message, "Failed to execute svn");
        assert.strictEqual(error.stdout, "partial output");
        assert.strictEqual(error.stderr, "svn: E175002: connection timed out");
        assert.strictEqual(error.stderrFormated, "connection timed out");
        assert.strictEqual(error.exitCode, 1);
        assert.strictEqual(error.svnErrorCode, "E175002");
        assert.strictEqual(error.svnCommand, "cat");
        return true;
      }
    );
  });

  test("timeout disposes all process listeners", async () => {
    await assert.rejects(
      svn.execBuffer("/repo", ["status"], { log: false, timeout: 1 }),
      (error: unknown) => error instanceof SvnError && error.exitCode === 124
    );

    assert.strictEqual(child.kill.callCount, 1);
    assertProcessListenersDisposed();
  });

  test("cancellation disposes process listeners and subscription", async () => {
    let cancel: (() => void) | undefined;
    const subscriptionDispose = sinon.spy();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener: () => void) {
        cancel = listener;
        return { dispose: subscriptionDispose };
      }
    };

    const result = svn.execBuffer("/repo", ["log"], {
      log: false,
      token: token as never
    });
    cancel?.();

    await assert.rejects(
      result,
      (error: unknown) => error instanceof SvnError && error.exitCode === 130
    );
    assert.strictEqual(child.kill.callCount, 1);
    assertProcessListenersDisposed();
    assert.strictEqual(subscriptionDispose.callCount, 1);
  });

  test("spawn error disposes all process listeners", async () => {
    const failure = new Error("spawn failed");
    queueMicrotask(() => child.emit("error", failure));

    await assert.rejects(
      svn.execBuffer("/repo", ["info"], { log: false }),
      failure
    );
    assertProcessListenersDisposed();
  });
});
