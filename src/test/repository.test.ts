import * as assert from "assert";
import * as fs from "original-fs";
import * as path from "path";
import { commands, Uri, window, workspace } from "vscode";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import * as testUtil from "./testUtil";

suite("Repository Tests", () => {
  const remoteFrequencyKey = "remoteChanges.checkFrequency";
  let repoUri: Uri;
  let checkoutDir: Uri;
  let sourceControlManager: SourceControlManager;
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
        `[test] skipping Repository Tests; missing binaries: ${missingBinaries.join(", ")}`
      );
      return;
    }

    try {
      await testUtil.activeExtension();
    } catch (err) {
      console.warn(
        `[test] skipping Repository Tests; extension unavailable: ${String(err)}`
      );
      return;
    }

    repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    checkoutDir = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(repoUri) + "/trunk"
    );

    const remoteConfig = workspace.getConfiguration("sven");
    previousRemoteFrequency =
      remoteConfig.inspect<number>(remoteFrequencyKey)?.workspaceValue;
    await remoteConfig.update(remoteFrequencyKey, 0, false);
    remotePollingDisabled = true;

    sourceControlManager = (await commands.executeCommand(
      "sven.getSourceControlManager",
      checkoutDir
    )) as SourceControlManager;
    suiteReady = true;
  });

  suiteTeardown(async () => {
    sourceControlManager?.openRepositories.forEach(repository =>
      repository.dispose()
    );
    await new Promise(resolve => setTimeout(resolve, 750));
    testUtil.destroyAllTempPaths();
    if (remotePollingDisabled) {
      await workspace
        .getConfiguration("sven")
        .update(remoteFrequencyKey, previousRemoteFrequency, false);
    }
  });

  testIfReady("Empty Open Repository", async function () {
    assert.equal(sourceControlManager.repositories.length, 0);
  });

  testIfReady("Try Open Repository", async function () {
    await sourceControlManager.tryOpenRepository(checkoutDir.fsPath);
    assert.equal(sourceControlManager.repositories.length, 1);
  });

  testIfReady("Try Open Repository Again", async () => {
    await sourceControlManager.tryOpenRepository(checkoutDir.fsPath);
    assert.equal(sourceControlManager.repositories.length, 1);
  });

  testIfReady("Try get repository from Uri", () => {
    const repository = sourceControlManager.getRepository(checkoutDir);
    assert.ok(repository);
  });

  testIfReady("Try get repository from string", () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    assert.ok(repository);
  });

  testIfReady("Try get repository from repository", () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    const repository2 = sourceControlManager.getRepository(repository);
    assert.ok(repository2);
    assert.equal(repository, repository2);
  });

  testIfReady("Try get current branch name", async () => {
    const repository: Repository | null = sourceControlManager.getRepository(
      checkoutDir.fsPath
    );
    if (!repository) {
      return;
    }

    const name = await repository.getCurrentBranch();
    assert.equal(name, "trunk");
  });

  testIfReady("Try commit file", async function () {
    this.timeout(60000);
    const repository: Repository | null = sourceControlManager.getRepository(
      checkoutDir.fsPath
    );
    if (!repository) {
      return;
    }

    assert.equal(repository.changes.resourceStates.length, 0);

    const file = path.join(checkoutDir.fsPath, "new.txt");

    fs.writeFileSync(file, "test");

    const document = await workspace.openTextDocument(file);
    await window.showTextDocument(document);

    await repository.addFiles([file]);

    assert.equal(repository.changes.resourceStates.length, 1);

    const message = await repository.commitFiles("First Commit", [file]);
    assert.ok(/1 file commited: revision (.*)\./i.test(message));

    assert.equal(repository.changes.resourceStates.length, 0);

    const remoteContent = await repository.show(file, "HEAD");
    assert.equal(remoteContent, "test");
  });

  testIfReady("Try switch branch", async function () {
    this.timeout(60000);
    const newCheckoutDir = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(repoUri) + "/trunk"
    );

    await sourceControlManager.tryOpenRepository(newCheckoutDir.fsPath);

    const newRepository: Repository | null = sourceControlManager.getRepository(
      newCheckoutDir.fsPath
    );
    if (!newRepository) {
      return;
    }
    assert.ok(newRepository);

    await newRepository.newBranch("branches/test");
    const currentBranch = await newRepository.getCurrentBranch();

    assert.equal(currentBranch, "branches/test");
  });
});
