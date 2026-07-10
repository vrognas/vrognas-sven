import { describe, it, expect, vi } from "vitest";
import { SyncStatusBar } from "../../../src/statusbar/syncStatusBar";
import { Repository } from "../../../src/repository";

/**
 * needCleanUp/isIncomplete were set by updateModelState but never copied
 * into the status-bar state on onDidChangeStatus - the "Need cleanup" and
 * "Incomplete checkout" affordances were unreachable and a wedged working
 * copy kept offering "Update Revision".
 */

function makeEvent() {
  const listeners: Array<() => void> = [];
  return {
    event: (fn: () => void, thisArg?: unknown, _disposables?: unknown[]) => {
      listeners.push(thisArg ? fn.bind(thisArg) : fn);
      return { dispose() {} };
    },
    fire: () => listeners.forEach(l => l())
  };
}

function makeRepo() {
  const status = makeEvent();
  const ops = makeEvent();
  const repo = {
    onDidChangeStatus: status.event,
    onDidChangeOperations: ops.event,
    remoteChangedFiles: 0,
    needCleanUp: false,
    isIncomplete: false,
    operations: { isRunning: () => false, isIdle: () => true }
  };
  return { repo, status };
}

describe("SyncStatusBar wedged-working-copy states", () => {
  it("offers cleanup when the working copy is admin-locked", () => {
    const { repo, status } = makeRepo();
    const bar = new SyncStatusBar(repo as unknown as Repository);

    repo.needCleanUp = true;
    status.fire();

    expect(bar.command?.command).toBe("sven.cleanup");
    bar.dispose();
  });

  it("offers finish-checkout when the checkout is incomplete", () => {
    const { repo, status } = makeRepo();
    const bar = new SyncStatusBar(repo as unknown as Repository);

    repo.isIncomplete = true;
    status.fire();

    expect(bar.command?.command).toBe("sven.finishCheckout");
    bar.dispose();
  });

  it("flashResult shows the outcome IN the item, then reverts", () => {
    vi.useFakeTimers();
    const { repo } = makeRepo();
    const bar = new SyncStatusBar(repo as unknown as Repository);

    bar.flashResult("Updated to revision 3001.");

    expect(bar.command?.title).toContain("Updated to revision 3001.");
    vi.runAllTimers();
    expect(bar.command?.title).not.toContain("Updated to revision 3001.");
    expect(bar.command?.command).toBe("sven.update"); // normal affordance back
    bar.dispose();
    vi.useRealTimers();
  });
});
