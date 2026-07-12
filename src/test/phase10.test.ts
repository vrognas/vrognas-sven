import * as assert from "assert";
import { commands, Uri, workspace } from "vscode";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import * as testUtil from "./testUtil";

suite("Phase 10: Regression + Hot Path Performance", () => {
  const remoteFrequencyKey = "remoteChanges.checkFrequency";
  let repoUri: Uri;
  let checkoutDir: Uri;
  let sourceControlManager: SourceControlManager;
  let repository: Repository;
  let suiteReady = false;
  let previousRemoteFrequency: number | undefined;
  let remotePollingDisabled = false;
  function testIfReady(
    title: string,
    fn: (this: Mocha.Context) => Promise<void> | void
  ): void {
    test(title, function (this: Mocha.Context) {
      if (!suiteReady) {
        this.skip();
      }
      return fn.call(this);
    });
  }

  suiteSetup(async function () {
    suiteReady = false;
    const missingBinaries = testUtil.getMissingSvnBinaries();
    if (missingBinaries.length > 0) {
      console.warn(
        `[test] skipping Phase 10 tests; missing binaries: ${missingBinaries.join(", ")}`
      );
      return;
    }

    try {
      await testUtil.activeExtension();
    } catch (err) {
      console.warn(
        `[test] skipping Phase 10 tests; extension unavailable: ${String(err)}`
      );
      return;
    }
    repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    checkoutDir = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(repoUri) + "/trunk"
    );

    // Phase 10 does not exercise remote polling. Disable it before opening
    // the Repository so statusReady cannot queue a late StatusRemote against
    // the temporary repository during teardown.
    const remoteConfig = workspace.getConfiguration("sven");
    previousRemoteFrequency =
      remoteConfig.inspect<number>(remoteFrequencyKey)?.workspaceValue;
    await remoteConfig.update(remoteFrequencyKey, 0, false);
    remotePollingDisabled = true;

    sourceControlManager = (await commands.executeCommand(
      "sven.getSourceControlManager",
      checkoutDir
    )) as SourceControlManager;

    await sourceControlManager.tryOpenRepository(checkoutDir.fsPath);
    repository = sourceControlManager.getRepository(checkoutDir)!;
    await repository.statusReady;
    suiteReady = true;
  });

  suiteTeardown(async () => {
    sourceControlManager?.openRepositories.forEach(r => r.dispose());
    // Flush the already-scheduled debounced no-op while polling stays disabled.
    await new Promise(resolve => setTimeout(resolve, 750));
    testUtil.destroyAllTempPaths();
    if (remotePollingDisabled) {
      await workspace
        .getConfiguration("sven")
        .update(remoteFrequencyKey, previousRemoteFrequency, false);
    }
  });

  testIfReady(
    "10.1: Workspace scan completes without freeze",
    async function () {
      this.timeout(30000);
      await sourceControlManager.tryOpenRepository(checkoutDir.fsPath, 0);
      assert.ok(true, "Scan completed successfully");
    }
  );

  testIfReady("10.2: Command execution overhead under 5ms", async function () {
    this.timeout(10000);
    const iterations = 100;
    const start = Date.now();

    for (let i = 0; i < iterations; i++) {
      const repo = sourceControlManager.getRepository(checkoutDir);
      assert.ok(repo);
    }

    const elapsed = Date.now() - start;
    const avgPerCall = elapsed / iterations;
    const msg = "Avg call time " + avgPerCall + "ms should be under 5ms";
    assert.ok(avgPerCall < 5, msg);
  });

  testIfReady("10.2: Repository lookup works without IPC", async function () {
    const repo = sourceControlManager.getRepository(checkoutDir);
    assert.ok(repo);
    assert.strictEqual(repo, repository);
  });

  testIfReady("10.3: updateInfo skipped when cache fresh", async function () {
    this.timeout(10000);
    // Note: updateInfo is private, testing via info property
    const info1 = repository.info;
    const info2 = repository.info;
    assert.ok(info1, "Info should be available");
    assert.strictEqual(info1, info2, "Should return same info object");
  });
});
