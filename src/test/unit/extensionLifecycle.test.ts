import * as assert from "assert";
import * as sinon from "sinon";
import { commands, Disposable } from "vscode";
import { activate } from "../../extension";
import { SourceControlManager } from "../../source_control_manager";
import { Svn } from "../../svn";
import { SvnFinder } from "../../svnFinder";

suite("Extension lifecycle", () => {
  let findSvnStub: sinon.SinonStub;
  let createManagerStub: sinon.SinonStub;
  let svnDisposeSpy: sinon.SinonSpy;

  setup(() => {
    findSvnStub = sinon
      .stub(SvnFinder.prototype, "findSvn")
      .resolves({ path: "svn", version: "1.14.0" });
    createManagerStub = sinon
      .stub(SourceControlManager, "create")
      .rejects(new Error("stop after SVN creation"));
    svnDisposeSpy = sinon.spy(Svn.prototype, "dispose");
  });

  teardown(() => {
    findSvnStub.restore();
    createManagerStub.restore();
    svnDisposeSpy.restore();
  });

  test("context disposal owns SVN and show-output registration", async () => {
    const subscriptions: Disposable[] = [];
    const context = {
      subscriptions,
      globalState: { get: sinon.stub(), update: sinon.stub().resolves() },
      workspaceState: { get: sinon.stub(), update: sinon.stub().resolves() }
    };

    await activate(context as never);
    assert.ok((await commands.getCommands()).includes("sven.showOutput"));

    subscriptions.forEach(disposable => disposable.dispose());
    const commandsAfterDispose = await commands.getCommands();
    const svnDisposed = svnDisposeSpy.calledOnce;

    // Avoid leaking the command when this characterization fails.
    commands.registerCommand("sven.showOutput", () => undefined).dispose();

    assert.ok(svnDisposed, "extension context must dispose Svn");
    assert.ok(
      !commandsAfterDispose.includes("sven.showOutput"),
      "extension context must dispose show-output registration"
    );
  });
});
