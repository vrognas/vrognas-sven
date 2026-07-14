import * as assert from "assert";
import * as path from "path";
import { Uri } from "vscode";
import { IOpenRepository } from "../../common/types";
import { Repository } from "../../repository";
import { RepositoryRegistry } from "../../repositoryRegistry";

suite("RepositoryRegistry", () => {
  const volumeRoot = path.parse(process.cwd()).root;

  function repository(root: string): Repository {
    const value = Object.create(Repository.prototype) as Repository;
    Object.defineProperties(value, {
      workspaceRoot: { value: root },
      sourceControl: { value: {} },
      changes: { value: {} }
    });
    return value;
  }

  function handle(value: Repository): IOpenRepository {
    return { repository: value, dispose: () => undefined };
  }

  test("keeps status exclusions separate from descendant ownership", () => {
    const registry = new RepositoryRegistry();
    const parentRoot = path.join(volumeRoot, "workspace");
    const externalRoot = path.join(parentRoot, "external");
    const parent = repository(parentRoot);
    const external = repository(externalRoot);
    registry.add(handle(parent));
    registry.setExclusions(parent, new Set([externalRoot]));
    const file = Uri.file(path.join(externalRoot, "file.txt"));

    assert.strictEqual(registry.resolveStatusUri(file), undefined);
    assert.strictEqual(registry.resolveDescendantUri(file), parent);

    registry.add(handle(external));
    assert.strictEqual(registry.resolveStatusUri(file)?.repository, external);
    assert.strictEqual(registry.resolveDescendantUri(file), external);
    assert.strictEqual(
      registry.resolveDescendantUri(
        Uri.file(path.join(volumeRoot, "workspace-sibling", "file.txt"))
      ),
      null
    );
  });

  test("resolves every supported hint to the live handle", () => {
    const registry = new RepositoryRegistry();
    const root = path.join(volumeRoot, "repo");
    const value = repository(root);
    const live = handle(value);
    registry.add(live);

    assert.strictEqual(registry.resolveHint(value), live);
    assert.strictEqual(registry.resolveHint({ repository: value }), live);
    assert.strictEqual(registry.resolveHint(value.sourceControl), live);
    assert.strictEqual(registry.resolveHint(value.changes), live);
    assert.strictEqual(registry.resolveHint(root), live);
    assert.strictEqual(registry.resolveHint(Uri.file(root)), live);
    assert.strictEqual(registry.resolveHint(repository(root)), undefined);
  });

  test("updates deepest ownership after removal", () => {
    const registry = new RepositoryRegistry();
    const parent = repository(path.join(volumeRoot, "repo"));
    const nested = repository(path.join(parent.workspaceRoot, "nested"));
    const parentHandle = handle(parent);
    const nestedHandle = handle(nested);
    registry.add(parentHandle);
    registry.add(nestedHandle);
    const file = Uri.file(path.join(nested.workspaceRoot, "file.txt"));

    assert.strictEqual(registry.resolveDescendantUri(file), nested);
    registry.remove(nestedHandle);
    assert.strictEqual(registry.resolveDescendantUri(file), parent);
    assert.deepStrictEqual(registry.repositories, [parent]);
  });
});
