import * as assert from "assert";
import * as path from "path";
import { CancellationToken, commands, Uri, window } from "vscode";
import { vi } from "vitest";
import { SetDepth } from "../../../commands/setDepth";
import { Command } from "../../../commands/command";
import SparseCheckoutProvider from "../../../treeView/dataProviders/sparseCheckoutProvider";
import { depthPickerOptions } from "../../../sparse/depthOptions";
import { collectUnsafeSparsePaths } from "../../../sparse/sparseOperations";
import * as util from "../../../util";

const ok = { stdout: "", stderr: "", exitCode: 0 };

function resource(filePath: string) {
  return { resourceUri: Uri.file(filePath) };
}

function repository(root: string) {
  return {
    workspaceRoot: root,
    changes: { resourceStates: [] as ReturnType<typeof resource>[] },
    unversioned: { resourceStates: [] as ReturnType<typeof resource>[] },
    beginSparseDownload: vi.fn(),
    endSparseDownload: vi.fn(),
    setDepth: vi.fn(async () => ok)
  };
}

function runProgress(cancelled = false) {
  return vi.spyOn(window, "withProgress").mockImplementation((_options, task) =>
    task({ report: vi.fn() }, {
      isCancellationRequested: cancelled,
      onCancellationRequested: vi.fn()
    } as unknown as CancellationToken)
  );
}

suite("Sparse production workflows", () => {
  teardown(() => {
    vi.restoreAllMocks();
    (
      Command as unknown as { _sourceControlManager?: unknown }
    )._sourceControlManager = undefined;
  });

  test("set-depth warns only for target descendants and preserves options", async () => {
    const root = path.resolve("sparse-repo");
    const target = path.join(root, "data");
    const changed = path.join(target, "changed.txt");
    const sibling = path.join(root, "database", "safe.txt");
    const repo = repository(root);
    repo.changes.resourceStates.push(resource(changed), resource(sibling));

    Command.setSourceControlManager({ getRepository: () => repo } as never);
    vi.spyOn(window, "showQuickPick").mockResolvedValue(
      depthPickerOptions[0] as never
    );
    const warning = vi
      .spyOn(window, "showWarningMessage")
      .mockResolvedValue("Continue Anyway" as never);
    runProgress();
    const executeCommand = vi
      .spyOn(commands, "executeCommand")
      .mockResolvedValue(undefined);

    const command = new SetDepth();
    await command.execute(Uri.file(target));
    command.dispose();

    const message = String(warning.mock.calls[0]?.[0]);
    assert.ok(message.includes(path.relative(root, changed)));
    assert.ok(!message.includes(path.relative(root, sibling)));
    assert.deepStrictEqual(repo.setDepth.mock.calls[0], [
      target,
      "exclude",
      {
        parents: true,
        timeout: 600_000
      }
    ]);
    assert.strictEqual(repo.beginSparseDownload.mock.calls.length, 1);
    assert.strictEqual(repo.endSparseDownload.mock.calls.length, 1);
    assert.ok(
      executeCommand.mock.calls.some(([name]) => name === "sven.sparse.refresh")
    );
  });

  test("unsafe scan preserves case-sensitive path identity", () => {
    const descendant = vi
      .spyOn(util, "isDescendantForSafety")
      .mockImplementation((parent, child) => {
        const normalizedParent = parent.replace(/[\\/]/g, "/");
        const normalizedChild = child.replace(/[\\/]/g, "/");
        return (
          normalizedChild === normalizedParent ||
          normalizedChild.startsWith(`${normalizedParent}/`)
        );
      });
    try {
      const root = path.resolve("case-repo");
      const repo = repository(root);
      repo.changes.resourceStates.push(
        resource(path.join(root, "data", "changed.txt"))
      );

      assert.deepStrictEqual(
        collectUnsafeSparsePaths(repo as never, path.join(root, "Data")),
        []
      );
    } finally {
      descendant.mockRestore();
    }
  });

  test("checkout cancellation uses one status envelope and still refreshes", async () => {
    const root = path.resolve("checkout-repo");
    const repo = repository(root);
    const provider = Object.create(SparseCheckoutProvider.prototype) as {
      checkoutItems(nodes: unknown[]): Promise<void>;
      sourceControlManager: {
        getRepository(uri: Uri): typeof repo | undefined;
      };
      speedSamples: number[];
      refresh: ReturnType<typeof vi.fn>;
    };
    provider.sourceControlManager = { getRepository: () => repo };
    provider.speedSamples = [];
    provider.refresh = vi.fn();
    const info = vi.spyOn(window, "showInformationMessage");
    runProgress(true);

    await provider.checkoutItems([
      {
        fullPath: path.join(root, "file.txt"),
        kind: "file",
        isGhost: true
      }
    ]);

    assert.strictEqual(repo.setDepth.mock.calls.length, 0);
    assert.strictEqual(repo.beginSparseDownload.mock.calls.length, 1);
    assert.strictEqual(repo.endSparseDownload.mock.calls.length, 1);
    assert.strictEqual(provider.refresh.mock.calls.length, 1);
    assert.match(
      String(info.mock.calls[0]?.[0]),
      /cancelled.*0 of 1 completed/i
    );
  });

  test("checkout failure keeps exact recovery message and skips refresh", async () => {
    const root = path.resolve("failed-checkout");
    const repo = repository(root);
    const provider = Object.create(SparseCheckoutProvider.prototype) as {
      checkoutItems(nodes: unknown[]): Promise<void>;
      sourceControlManager: {
        getRepository(uri: Uri): typeof repo | undefined;
      };
      speedSamples: number[];
      refresh: ReturnType<typeof vi.fn>;
    };
    provider.sourceControlManager = { getRepository: () => repo };
    provider.speedSamples = [];
    provider.refresh = vi.fn();
    vi.spyOn(window, "withProgress").mockRejectedValue(new Error("network"));
    const showError = vi
      .spyOn(window, "showErrorMessage")
      .mockResolvedValue(undefined);

    await provider.checkoutItems([
      {
        fullPath: path.join(root, "file.txt"),
        kind: "file",
        isGhost: true
      }
    ]);

    assert.deepStrictEqual(showError.mock.calls[0], [
      "Download failed: Error: network",
      "Show Output"
    ]);
    assert.strictEqual(provider.refresh.mock.calls.length, 0);
    assert.strictEqual(repo.beginSparseDownload.mock.calls.length, 1);
    assert.strictEqual(repo.endSparseDownload.mock.calls.length, 1);
  });

  test("exclude batch continues after failure and aggregates once", async () => {
    const rootA = path.resolve("exclude-a");
    const rootB = path.resolve("exclude-b");
    const repoA = repository(rootA);
    const repoB = repository(rootB);
    repoA.setDepth
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new Error("failed"));
    repoB.setDepth.mockResolvedValueOnce(ok);

    const provider = Object.create(SparseCheckoutProvider.prototype) as {
      excludeItems(nodes: unknown[]): Promise<void>;
      sourceControlManager: {
        getRepository(uri: Uri): typeof repoA | undefined;
      };
      refresh: ReturnType<typeof vi.fn>;
    };
    provider.sourceControlManager = {
      getRepository: uri => (uri.fsPath.startsWith(rootA) ? repoA : repoB)
    };
    provider.refresh = vi.fn();
    const warning = vi
      .spyOn(window, "showWarningMessage")
      .mockResolvedValue("Exclude" as never);
    runProgress();

    const paths = [
      path.join(rootA, "one"),
      path.join(rootA, "two"),
      path.join(rootB, "three")
    ];
    await provider.excludeItems(paths.map(fullPath => ({ fullPath })));

    assert.deepStrictEqual(
      [...repoA.setDepth.mock.calls, ...repoB.setDepth.mock.calls],
      [
        [paths[0], "exclude"],
        [paths[1], "exclude"],
        [paths[2], "exclude"]
      ]
    );
    for (const repo of [repoA, repoB]) {
      assert.strictEqual(repo.beginSparseDownload.mock.calls.length, 1);
      assert.strictEqual(repo.endSparseDownload.mock.calls.length, 1);
    }
    assert.strictEqual(provider.refresh.mock.calls.length, 1);
    assert.ok(
      warning.mock.calls.some(([message]) =>
        String(message).includes("2 succeeded, 1 failed")
      )
    );
  });
});
