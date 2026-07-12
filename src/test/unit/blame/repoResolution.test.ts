import * as assert from "assert";
import { Uri } from "vscode";
import { BlameProvider } from "../../../blame/blameProvider";

suite("BlameProvider - repo resolution (externals)", () => {
  test("resolves via descendant match, not the exclude-filtered getRepository", () => {
    const repo = { workspaceRoot: "/ws" };
    // getRepository rejects paths in the repo's excluded set (svn:externals +
    // ignored); getRepositoryFromUri is a pure descendant match that owns them.
    const scm = {
      getRepository: () => null,
      getRepositoryFromUri: () => repo
    };
    const provider = new BlameProvider(scm as never);
    try {
      const resolved = (
        provider as never as {
          repoFor: (u: Uri) => unknown;
        }
      ).repoFor(Uri.file("/ws/externals/shared/util.ts"));
      assert.strictEqual(
        resolved,
        repo,
        "a file inside an svn:external must still resolve to its owning repo"
      );
    } finally {
      provider.dispose();
    }
  });
});
