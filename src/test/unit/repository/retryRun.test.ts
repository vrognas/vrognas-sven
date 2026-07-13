import * as assert from "assert";
import { svnErrorCodes } from "../../../svn";
import SvnError from "../../../svnError";
import { IStoredAuth } from "../../../common/types";

/**
 * Characterization tests for the REAL Repository.retryRun (the auth-retry
 * ladder). Replaces a simulation-only suite that re-implemented the logic
 * inline and never called retryRun — false coverage over a path that has
 * shipped two real bugs (account-cycling index, empty first-attempt creds).
 *
 * Uses the Repository.prototype.call(mockThis) pattern established by
 * blameInvalidation.test.ts, since the Repository constructor is not
 * unit-constructible (F31).
 */

interface MockThis {
  repository: { isDisposed: boolean };
  username?: string;
  password?: string;
  credentialLock: Promise<void>;
  loadStoredAuths: () => Promise<IStoredAuth[]>;
  saveAuth: () => Promise<void>;
  promptAuth: () => Promise<boolean | undefined>;
}

function makeMockThis(overrides: Partial<MockThis> = {}): MockThis {
  return {
    repository: { isDisposed: false },
    username: undefined,
    password: undefined,
    credentialLock: Promise.resolve(),
    loadStoredAuths: async () => [],
    saveAuth: async () => {},
    promptAuth: async () => undefined,
    ...overrides
  };
}

function authError(): SvnError {
  return new SvnError({
    message: "Failed to execute svn",
    svnErrorCode: svnErrorCodes.AuthorizationFailed
  });
}

async function getRetryRun() {
  const { Repository } = await import("../../../repository");
  return (Repository.prototype as unknown as Record<string, unknown>)
    .retryRun as (runOperation: () => Promise<unknown>) => Promise<unknown>;
}

suite("Repository retryRun (real implementation)", () => {
  test("pre-sets first stored account, cycles through accounts on auth failure", async () => {
    const retryRun = await getRetryRun();
    const accounts: IStoredAuth[] = [
      { account: "alice", password: "a1" },
      { account: "bob", password: "b2" },
      { account: "carol", password: "c3" }
    ];
    const mockThis = makeMockThis({
      loadStoredAuths: async () => accounts
    });

    const credsPerAttempt: Array<string | undefined> = [];
    let attempts = 0;
    const result = await retryRun.call(mockThis, async () => {
      credsPerAttempt.push(mockThis.username);
      attempts++;
      if (attempts <= 2) {
        throw authError();
      }
      return "committed";
    });

    assert.strictEqual(result, "committed");
    // attempt 1 pre-set to accounts[0]; failures advance to [1] then [2]
    assert.deepStrictEqual(credsPerAttempt, ["alice", "bob", "carol"]);
    assert.strictEqual(mockThis.password, "c3");
  });

  test("serializes concurrent calls via the credential mutex", async () => {
    const retryRun = await getRetryRun();
    const mockThis = makeMockThis();

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = retryRun.call(mockThis, async () => {
      order.push("op1-start");
      await firstBlocked;
      order.push("op1-end");
      return 1;
    });
    // Give the first call time to take the lock, then start the second
    await new Promise(r => setTimeout(r, 20));
    const second = retryRun.call(mockThis, async () => {
      order.push("op2-start");
      return 2;
    });
    await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(
      order,
      ["op1-start"],
      "second operation must not run credentials while first holds the lock"
    );

    releaseFirst();
    assert.deepStrictEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepStrictEqual(order, ["op1-start", "op1-end", "op2-start"]);
  });

  test("retries RepositoryIsLocked with backoff, then succeeds", async () => {
    const retryRun = await getRetryRun();
    const mockThis = makeMockThis();

    let attempts = 0;
    const started = Date.now();
    const result = await retryRun.call(mockThis, async () => {
      attempts++;
      if (attempts === 1) {
        throw new SvnError({
          message: "Failed to execute svn",
          svnErrorCode: svnErrorCodes.RepositoryIsLocked
        });
      }
      return "ok";
    });

    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 2);
    // quadratic backoff: attempt 1 waits 1^2 * 50 = 50ms
    assert.ok(Date.now() - started >= 45, "should back off before retrying");
  });

  test("does not retry after disposal during backoff", async () => {
    const retryRun = await getRetryRun();
    const mockThis = makeMockThis();
    let markFirstAttempt!: () => void;
    const firstAttempt = new Promise<void>(
      resolve => (markFirstAttempt = resolve)
    );
    let attempts = 0;

    const pending = retryRun.call(mockThis, async () => {
      attempts++;
      if (attempts === 1) {
        markFirstAttempt();
        throw new SvnError({
          message: "Failed to execute svn",
          svnErrorCode: svnErrorCodes.RepositoryIsLocked
        });
      }
      return "must not run";
    });
    await firstAttempt;
    await new Promise(resolve => setTimeout(resolve, 10));
    mockThis.repository.isDisposed = true;

    await assert.rejects(pending, /disposed/i);
    assert.strictEqual(attempts, 1);
  });

  test("propagates auth failure when no accounts and prompt is declined", async () => {
    const retryRun = await getRetryRun();
    let prompted = 0;
    const mockThis = makeMockThis({
      promptAuth: async () => {
        prompted++;
        return false; // user declined
      }
    });

    let attempts = 0;
    await assert.rejects(
      retryRun.call(mockThis, async () => {
        attempts++;
        throw authError();
      }),
      (err: unknown) =>
        (err as SvnError).svnErrorCode === svnErrorCodes.AuthorizationFailed
    );
    assert.strictEqual(attempts, 1, "no accounts to cycle: single attempt");
    assert.strictEqual(prompted, 1, "falls back to prompting the user once");
  });
});
