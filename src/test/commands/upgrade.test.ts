import * as assert from "assert";
import * as sinon from "sinon";
import { commands, window } from "vscode";
import { Upgrade } from "../../commands/upgrade";
import { SourceControlManager } from "../../source_control_manager";

function normalizePathForAssert(value: string): string {
  return value.replace(/\\/g, "/");
}

suite("Upgrade Command E2E Tests", () => {
  let upgradeCmd: Upgrade;
  let mockSourceControlManager: SourceControlManager;
  let upgradeStub: sinon.SinonStub;
  let warningStub: sinon.SinonStub;
  let infoStub: sinon.SinonStub;
  let errorStub: sinon.SinonStub;

  setup(() => {
    upgradeCmd = new Upgrade();
    mockSourceControlManager = {
      upgradeWorkingCopy: async () => true,
      tryOpenRepository: () => {}
    } as any;
    upgradeStub = sinon.stub(mockSourceControlManager, "upgradeWorkingCopy");
    warningStub = sinon.stub(window, "showWarningMessage" as any);
    // Success confirmation is inline status-bar feedback, not a toast
    infoStub = sinon.stub(window, "setStatusBarMessage" as any);
    errorStub = sinon.stub(window, "showErrorMessage" as any);
    sinon.stub(commands, "executeCommand").resolves(mockSourceControlManager);
  });

  teardown(() => {
    upgradeCmd.dispose();
    sinon.restore();
  });

  test("Upgrade success - verify working copy upgraded", async () => {
    warningStub.resolves("Yes");
    upgradeStub.resolves(true);

    await upgradeCmd.execute("/test/workspace");

    assert.ok(warningStub.calledOnce, "Warning dialog should be shown");
    assert.ok(
      warningStub.firstCall.args[0].includes("upgrade"),
      "Warning should mention upgrade"
    );
    assert.ok(upgradeStub.calledOnce, "upgradeWorkingCopy should be called");
    assert.strictEqual(
      normalizePathForAssert(upgradeStub.firstCall.args[0]),
      normalizePathForAssert("/test/workspace"),
      "Should upgrade correct path"
    );
    assert.ok(infoStub.calledOnce, "Success message should be shown");
    assert.ok(
      infoStub.firstCall.args[0].includes("upgraded"),
      "Success message should mention upgraded"
    );
  });

  test("No upgrade needed - verify already up-to-date behavior", async () => {
    warningStub.resolves("No");

    await upgradeCmd.execute("/test/workspace");

    assert.ok(warningStub.calledOnce, "Warning dialog should be shown");
    assert.ok(
      upgradeStub.notCalled,
      "upgradeWorkingCopy should not be called when user declines"
    );
    assert.ok(infoStub.notCalled, "No success message should be shown");
    assert.ok(errorStub.notCalled, "No error message should be shown");
  });

  test("Upgrade error - test error handling", async () => {
    warningStub.resolves("Yes");
    upgradeStub.resolves(false);

    await upgradeCmd.execute("/test/workspace");

    assert.ok(warningStub.calledOnce, "Warning dialog should be shown");
    assert.ok(upgradeStub.calledOnce, "upgradeWorkingCopy should be called");
    assert.ok(errorStub.calledOnce, "Error message should be shown");
    assert.ok(
      errorStub.firstCall.args[0].includes("Error"),
      "Error message should indicate failure"
    );
    assert.ok(
      infoStub.notCalled,
      "No success message should be shown on error"
    );
  });
});
