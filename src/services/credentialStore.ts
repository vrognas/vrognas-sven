import { SecretStorage } from "vscode";
import { IStoredAuth } from "../common/types";
import { logError } from "../util/errorLogger";

type CacheEntry = {
  readonly accounts: IStoredAuth[];
  readonly expiry: number;
};

type ReadEntry = {
  readonly generation: number;
  readonly promise: Promise<IStoredAuth[]>;
};

/** Shared SecretStorage access, serialized per server credential key. */
export class CredentialStore {
  private static readonly instances = new WeakMap<
    SecretStorage,
    CredentialStore
  >();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly reads = new Map<string, ReadEntry>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  static for(secrets: SecretStorage): CredentialStore {
    let store = this.instances.get(secrets);
    if (!store) {
      store = new CredentialStore(secrets);
      this.instances.set(secrets, store);
    }
    return store;
  }

  constructor(
    private readonly secrets: SecretStorage,
    private readonly ttlMs = 60_000
  ) {}

  private parse(secret: string | undefined): IStoredAuth[] {
    if (secret === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(secret);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (value): value is IStoredAuth =>
          value !== null &&
          typeof value === "object" &&
          "account" in value &&
          typeof value.account === "string" &&
          "password" in value &&
          typeof value.password === "string"
      );
    } catch (error) {
      logError("Failed to parse stored credentials", error);
      return [];
    }
  }

  private async readUncached(key: string): Promise<IStoredAuth[]> {
    return this.parse(await this.secrets.get(key));
  }

  private async waitForWrite(key: string): Promise<void> {
    while (this.writes.has(key)) {
      await this.writes.get(key)?.catch(() => undefined);
    }
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  async load(key: string): Promise<IStoredAuth[]> {
    await this.waitForWrite(key);
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiry) {
      return cached.accounts.map(account => ({ ...account }));
    }
    const generation = this.generation(key);
    const current = this.reads.get(key);
    if (current?.generation === generation) {
      return current.promise.then(accounts =>
        accounts.map(account => ({ ...account }))
      );
    }
    if (current) this.reads.delete(key);

    const read: Promise<IStoredAuth[]> = this.readUncached(key)
      .then(accounts => {
        if (this.generation(key) === generation) {
          this.cache.set(key, {
            accounts: accounts.map(account => ({ ...account })),
            expiry: Date.now() + this.ttlMs
          });
        }
        return accounts;
      })
      .catch(error => {
        logError("Failed to load stored credentials", error);
        return [];
      })
      .finally(() => {
        if (this.reads.get(key)?.promise === read) this.reads.delete(key);
      });
    const entry: ReadEntry = { generation, promise: read };
    if (this.generation(key) === generation) {
      this.reads.set(key, entry);
    }
    return read;
  }

  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writes.set(key, next);
    const cleanup = () => {
      if (this.writes.get(key) === next) this.writes.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  saveAccount(key: string, account: IStoredAuth): Promise<void> {
    const generation = this.generation(key);
    return this.enqueue(key, async () => {
      await this.reads.get(key)?.promise.catch(() => undefined);
      const accounts = await this.readUncached(key);
      const index = accounts.findIndex(
        value => value.account === account.account
      );
      if (index >= 0) accounts[index] = { ...account };
      else accounts.push({ ...account });
      await this.secrets.store(key, JSON.stringify(accounts));
      if (this.generation(key) === generation) {
        this.cache.set(key, {
          accounts: accounts.map(value => ({ ...value })),
          expiry: Date.now() + this.ttlMs
        });
      }
    });
  }

  delete(key: string): Promise<void> {
    return this.enqueue(key, async () => {
      await this.reads.get(key)?.promise.catch(() => undefined);
      await this.secrets.delete(key);
      this.cache.delete(key);
    });
  }

  invalidate(key: string): void {
    this.generations.set(key, this.generation(key) + 1);
    this.cache.delete(key);
    this.reads.delete(key);
  }
}
