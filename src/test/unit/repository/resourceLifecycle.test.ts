import * as assert from "assert";
import * as sinon from "sinon";
import { ConfigurationChangeEvent, Disposable, Event, Uri } from "vscode";
import { Repository } from "../../../repository";
import { configuration } from "../../../helpers/configuration";

suite("Repository owned resources", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(Repository.prototype, "status").resolves(undefined);
    sandbox
      .stub(Repository.prototype, "updateRemoteChangedFiles")
      .resolves(undefined);
  });

  teardown(() => sandbox.restore());

  function captureConfigurationSubscriptions() {
    const subscriptions: Array<{ disposed: boolean }> = [];
    const event: Event<ConfigurationChangeEvent> = (
      _listener,
      _thisArgs,
      disposables
    ) => {
      const subscription = { disposed: false };
      const disposable = new Disposable(() => {
        subscription.disposed = true;
      });
      subscriptions.push(subscription);
      disposables?.push(disposable);
      return disposable;
    };
    sandbox.stub(configuration, "onDidChange").get(() => event);
    return subscriptions;
  }

  function createRepository(): Repository {
    const root = Uri.file("/workspace/repository").fsPath;
    const baseRepository = {
      root,
      workspaceRoot: root,
      clearInfoCacheTimers: sandbox.spy(),
      isDisposed: false
    };
    const secrets = {
      get: sandbox.stub().resolves(undefined),
      store: sandbox.stub().resolves(undefined),
      delete: sandbox.stub().resolves(undefined)
    };
    return new Repository(baseRepository as never, secrets as never);
  }

  test("dispose releases every configuration subscription", () => {
    const subscriptions = captureConfigurationSubscriptions();
    const repository = createRepository();

    repository.dispose();

    assert.ok(subscriptions.length >= 3);
    assert.ok(
      subscriptions.every(subscription => subscription.disposed),
      "repository-owned configuration listener remained live"
    );
  });

  test("dispose cancels deferred property-cache warmup", async () => {
    const clock = sandbox.useFakeTimers();
    captureConfigurationSubscriptions();
    const refresh = sandbox
      .stub(Repository.prototype, "refreshAllPropertyCaches")
      .resolves(undefined);
    const repository = createRepository();
    await Promise.resolve();

    repository.dispose();
    await clock.tickAsync(3000);

    assert.strictEqual(refresh.callCount, 0);
  });
});
