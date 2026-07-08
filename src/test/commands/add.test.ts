import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, window } from "vscode";
import { Add } from "../../commands/add";
import { Repository } from "../../svnRepository";
import { Svn } from "../../svn";
import { ISvnOptions } from "../../common/types";
import { Resource } from "../../resource";
import { Status } from "../../common/types";

suite("Add Command E2E Tests", () => {
  let addCmd: Add;
  let repository: Repository;
  let execStub: sinon.SinonStub;
  const svnOptions: ISvnOptions = {
    svnPath: "svn",
    version: "1.9"
  };

  setup(async () => {
    addCmd = new Add();
    const svn = new Svn(svnOptions);
    repository = new Repository(svn, "/test/workspace", "/test/workspace");
    execStub = sinon.stub(repository, "exec" as any);
  });

  teardown(() => {
    addCmd.dispose();
    sinon.restore();
  });

  test("Add single file - verify file added to SVN", async () => {
    execStub.resolves({ exitCode: 0, stdout: "A    newfile.txt", stderr: "" });

    const fileUri = Uri.file("/test/workspace/newfile.txt");
    const resource = new Resource(fileUri, Status.UNVERSIONED);

    // Mock command internals to use our test repository
    (addCmd as any).getResourceStates = async () => [resource];
    (addCmd as any).runByRepository = async (uris: any, fn: any) => {
      await fn(repository, uris);
    };

    await addCmd.execute(resource);

    assert.ok(execStub.calledOnce, "exec should be called once");
    const args = execStub.firstCall.args[0];
    assert.ok(args.includes("add"), "Command should be 'add'");
    assert.ok(args.includes("newfile.txt"), "Should add newfile.txt");
  });

  test("Add multiple files - verify batch add", async () => {
    execStub.resolves({
      exitCode: 0,
      stdout: "A    file1.txt\nA    file2.txt\nA    file3.txt",
      stderr: ""
    });

    const files = [
      Uri.file("/test/workspace/file1.txt"),
      Uri.file("/test/workspace/file2.txt"),
      Uri.file("/test/workspace/file3.txt")
    ];
    const resources = files.map(f => new Resource(f, Status.UNVERSIONED));

    (addCmd as any).getResourceStates = async () => resources;
    (addCmd as any).runByRepository = async (uris: any, fn: any) => {
      await fn(repository, uris);
    };

    await addCmd.execute(...resources);

    assert.ok(execStub.calledOnce, "exec should be called once for batch");
    const args = execStub.firstCall.args[0];
    assert.ok(args.includes("add"), "Command should be 'add'");
    assert.ok(args.includes("file1.txt"), "Should add file1.txt");
    assert.ok(args.includes("file2.txt"), "Should add file2.txt");
    assert.ok(args.includes("file3.txt"), "Should add file3.txt");
  });

  test("Add error - verify error handling", async () => {
    execStub.rejects(new Error("svn: E155007: Path is not a working copy"));

    const fileUri = Uri.file("/test/workspace/error.txt");
    const resource = new Resource(fileUri, Status.UNVERSIONED);

    const errorStub = sinon.stub(window, "showErrorMessage");

    (addCmd as any).getResourceStates = async () => [resource];
    (addCmd as any).runByRepository = async (uris: any, fn: any) => {
      await fn(repository, uris);
    };

    await addCmd.execute(resource);

    assert.ok(execStub.calledOnce, "exec should be called");
    assert.ok(errorStub.calledOnce, "Error message should be shown");
    assert.ok(
      errorStub.firstCall.args[0].includes("Unable to add file"),
      "Error message should mention add failure"
    );
  });
});
