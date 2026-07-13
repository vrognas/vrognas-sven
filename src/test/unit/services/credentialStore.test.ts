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
});
