import * as assert from "assert";
import * as sinon from "sinon";
import { commands } from "vscode";
import { Repository } from "../../../repository";
import { configuration } from "../../../helpers/configuration";

suite("Repository commit disposal", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(configuration, "commitAutoUpdate").returns("none");
    sandbox.stub(commands, "executeCommand").resolves(undefined);
  });

  teardown(() => sandbox.restore());

  function mockRepository(
    refresh: (repository: { isDisposed: boolean }) => Promise<void>
  ): any {
    const repository = {
      isDisposed: false,
      updateInfo: async () => refresh(repository)
    };
    return {
      needsLockCacheExpiry: Number.POSITIVE_INFINITY,
      hasNeedsLock: async () => false,
      run: async () => "commit succeeded",
      repository
    };
  }

  test("successful commit survives disposal during post-refresh", async () => {
    const mockThis = mockRepository(async repository => {
      repository.isDisposed = true;
      throw new Error("Repository disposed");
    });

    const result = await (Repository.prototype as any).commitFiles.call(
      mockThis,
      "message",
      []
    );

    assert.strictEqual(result, "commit succeeded");
  });

  test("live post-refresh failures still reject", async () => {
    const mockThis = mockRepository(async () => {
      throw new Error("refresh failed");
    });

    await assert.rejects(
      (Repository.prototype as any).commitFiles.call(mockThis, "message", []),
      /refresh failed/
    );
  });
});
