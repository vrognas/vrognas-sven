import * as assert from "assert";
import * as sinon from "sinon";
import { Uri } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";

suite("BlameProvider - message cache scoping", () => {
  let sandbox: sinon.SinonSandbox;
  let provider: BlameProvider;

  setup(() => (sandbox = sinon.createSandbox()));
  teardown(() => {
    provider?.dispose();
    sandbox.restore();
  });

  test("scopes commit messages per repo (no cross-repo revision collision)", async () => {
    const repoA = {
      workspaceRoot: "/a",
      log: sinon.stub().resolves([{ revision: "42", msg: "A message" }])
    };
    const repoB = {
      workspaceRoot: "/b",
      log: sinon.stub().resolves([{ revision: "42", msg: "B message" }])
    };
    const scm = {
      getRepositoryFromUri: (uri: Uri) =>
        uri.path.startsWith("/a") ? repoA : repoB
    };
    provider = new BlameProvider(scm as never);
    sandbox.stub(blameConfiguration, "isLogsEnabled").returns(true);

    const get = (
      provider as never as {
        getCommitMessage: (r: string, u: Uri) => Promise<string>;
      }
    ).getCommitMessage.bind(provider);

    const a = await get("42", Uri.file("/a/file.ts"));
    const b = await get("42", Uri.file("/b/file.ts"));

    assert.strictEqual(a, "A message");
    assert.strictEqual(
      b,
      "B message",
      "repoB's r42 must not be served repoA's cached r42 message"
    );
  });
});
