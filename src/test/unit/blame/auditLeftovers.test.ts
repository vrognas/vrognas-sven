import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { Uri, workspace } from "vscode";
import { Blame } from "../../../commands/blame";
import { blameStateManager } from "../../../blame/blameStateManager";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";

function makeMockRepo(sandbox: sinon.SinonSandbox) {
  return {
    statusReady: Promise.resolve(),
    getResourceFromFile: sandbox.stub().returns(undefined),
    isInsideUnversionedOrIgnored: sandbox.stub().returns(undefined),
    blame: sandbox.stub().resolves([])
  };
}

suite("Audit leftovers", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite("sven.blameFile wires into the blame UI", () => {
    test("enables blame for the file instead of a discarded fetch", async () => {
      const uri = Uri.file("/test/file.ts");
      blameStateManager.setBlameEnabled(uri, false);
      const mockRepo = makeMockRepo(sandbox);

      const cmd = new Blame();
      try {
        await cmd.execute(mockRepo as unknown as Repository, uri);

        assert.strictEqual(
          blameStateManager.isBlameEnabled(uri),
          true,
          "command must enable blame decorations for the file"
        );
        assert.ok(
          mockRepo.blame.notCalled,
          "no direct fetch - the provider fetches via shared caches"
        );
      } finally {
        cmd.dispose();
        blameStateManager.clearBlame(uri);
      }
    });

    test("explicit revision keeps the programmatic fetch path", async () => {
      const uri = Uri.file("/test/file.ts");
      const mockRepo = makeMockRepo(sandbox);

      const cmd = new Blame();
      try {
        await cmd.execute(mockRepo as unknown as Repository, uri, "42");
        assert.ok(mockRepo.blame.calledOnceWith(uri.fsPath, "42"));
      } finally {
        cmd.dispose();
      }
    });
  });

  suite("revision colors are range-aware", () => {
    test("same revision colors differently in different files' ranges", () => {
      const mockRepository = sandbox.createStubInstance(Repository);
      (mockRepository as any).repository = {
        workspaceRoot: "/test",
        root: "/test"
      };
      const provider = new BlameProvider(scmFor(mockRepository as any));
      try {
        // File A: r100 is the newest revision (categorical red)
        const colorA = (provider as any).getRevisionColor("100", {
          min: 80,
          max: 100,
          uniqueRevisions: [100, 95, 90, 85, 80]
        });
        // File B: r100 is deep in the tail (gradient bucket)
        const colorB = (provider as any).getRevisionColor("100", {
          min: 10,
          max: 200,
          uniqueRevisions: [
            200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100, 90, 10
          ]
        });

        assert.notStrictEqual(
          colorA,
          colorB,
          "heatmap position depends on the file's revision range - " +
            "a revision-only cache freezes the first file's palette"
        );
      } finally {
        provider.dispose();
      }
    });
  });

  suite("multipleFolders depth honors the enabled flag", () => {
    test("config change does not raise scan depth while disabled", async () => {
      const { SourceControlManager } = await import(
        "../../../source_control_manager"
      );
      const cfg = workspace.getConfiguration("sven");
      await cfg.update("multipleFolders.depth", 4);
      await cfg.update("multipleFolders.enabled", false);
      try {
        const mockThis: any = { maxDepth: 0 };
        const handler = (SourceControlManager.prototype as any)
          .onDidChangeConfiguration;

        handler.call(mockThis);
        assert.strictEqual(
          mockThis.maxDepth,
          0,
          "depth must stay 0 while multipleFolders is disabled"
        );

        await cfg.update("multipleFolders.enabled", true);
        handler.call(mockThis);
        assert.strictEqual(mockThis.maxDepth, 4, "enabled: depth applies");
      } finally {
        await cfg.update("multipleFolders.depth", undefined);
        await cfg.update("multipleFolders.enabled", undefined);
      }
    });
  });
});
