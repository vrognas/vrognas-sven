import * as assert from "assert";
import { CredentialStore } from "../../../services/credentialStore";

class MemorySecrets {
  private readonly values = new Map<string, string>();
  readonly reads: string[] = [];

  async get(key: string): Promise<string | undefined> {
    this.reads.push(key);
    await Promise.resolve();
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    await Promise.resolve();
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

suite("CredentialStore", () => {
  test("serializes same-server account saves", async () => {
    const secrets = new MemorySecrets();
    const store = new CredentialStore(secrets as never);

    await Promise.all([
      store.saveAccount("vscode.sven:https://svn.example.com", {
        account: "alice",
        password: "a"
      }),
      store.saveAccount("vscode.sven:https://svn.example.com", {
        account: "bob",
        password: "b"
      })
    ]);

    assert.deepStrictEqual(
      await store.load("vscode.sven:https://svn.example.com"),
      [
        { account: "alice", password: "a" },
        { account: "bob", password: "b" }
      ]
    );
  });

  test("deduplicates concurrent reads", async () => {
    const secrets = new MemorySecrets();
    await secrets.store(
      "server",
      JSON.stringify([{ account: "alice", password: "a" }])
    );
    const store = new CredentialStore(secrets as never);

    const [first, second] = await Promise.all([
      store.load("server"),
      store.load("server")
    ]);

    assert.deepStrictEqual(first, second);
    assert.strictEqual(secrets.reads.length, 1);
  });

  test("delete invalidates cached accounts", async () => {
    const secrets = new MemorySecrets();
    const store = new CredentialStore(secrets as never);
    await store.saveAccount("server", { account: "alice", password: "a" });

    await store.delete("server");

    assert.deepStrictEqual(await store.load("server"), []);
  });

  test("invalidate fences an in-flight read from the cache", async () => {
    const staleSecret = JSON.stringify([{ account: "alice", password: "old" }]);
    const freshSecret = JSON.stringify([{ account: "alice", password: "new" }]);
    let reads = 0;
    let resolveFirst: ((value: string | undefined) => void) | undefined;
    const secrets = {
      get(): Promise<string | undefined> {
        reads++;
        if (reads === 1) {
          return new Promise(resolve => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(freshSecret);
      },
      store: async () => undefined,
      delete: async () => undefined
    };
    const store = new CredentialStore(secrets as never);

    const staleLoad = store.load("server");
    for (let i = 0; i < 10 && !resolveFirst; i++) {
      await Promise.resolve();
    }
    assert.ok(resolveFirst, "first storage read must be pending");
    store.invalidate("server");
    const freshLoad = store.load("server");
    resolveFirst(staleSecret);

    assert.deepStrictEqual(await staleLoad, [
      { account: "alice", password: "old" }
    ]);
    const expected = [{ account: "alice", password: "new" }];
    assert.deepStrictEqual(await freshLoad, expected);
    assert.deepStrictEqual(await store.load("server"), expected);
    assert.strictEqual(reads, 2);
  });

  test("invalidate cannot deadlock a save waiting on the old read", async () => {
    let reads = 0;
    let resolveFirst: ((value: string | undefined) => void) | undefined;
    const secrets = {
      get(): Promise<string | undefined> {
        reads++;
        if (reads === 1) {
          return new Promise(resolve => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve("[]");
      },
      store: async () => undefined,
      delete: async () => undefined
    };
    const store = new CredentialStore(secrets as never);
    const pendingLoad = store.load("server");
    for (let i = 0; i < 10 && !resolveFirst; i++) {
      await Promise.resolve();
    }
    assert.ok(resolveFirst, "first storage read must be pending");

    const pendingSave = store.saveAccount("server", {
      account: "alice",
      password: "new"
    });
    await Promise.resolve();
    await Promise.resolve();
    store.invalidate("server");
    let settled = false;
    void Promise.all([pendingLoad, pendingSave]).then(() => {
      settled = true;
    });
    resolveFirst("[]");
    for (let i = 0; i < 20 && !settled; i++) {
      await Promise.resolve();
    }

    assert.strictEqual(settled, true);
    assert.strictEqual(reads, 2);
  });
});
