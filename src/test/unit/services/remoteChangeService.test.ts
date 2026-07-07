import * as assert from "assert";
import { describe, it } from "mocha";
import {
  RemoteChangeService,
  RemoteChangeConfig
} from "../../../services/RemoteChangeService";

/**
 * RemoteChangeService E2E Tests
 *
 * Tests actual polling behavior without mocking:
 * - Timer lifecycle (start/stop)
 * - Callback invocation at intervals
 * - Error resilience
 */
describe("RemoteChangeService E2E", () => {
  function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise.then(
        value => {
          clearTimeout(timeoutHandle);
          resolve(value);
        },
        err => {
          clearTimeout(timeoutHandle);
          reject(err);
        }
      );
    });
  }

  /**
   * Test 1: Start polling - verify timer starts and calls update
   */
  it("start polling invokes callback at configured intervals", async () => {
    let callCount = 0;
    const config: RemoteChangeConfig = { checkFrequencySeconds: 0.05 }; // 50ms

    const service = new RemoteChangeService(
      async () => {
        callCount++;
      },
      () => config
    );

    service.start();
    assert.strictEqual(
      service.isRunning,
      true,
      "Service should be running after start"
    );

    // Wait for ~2 intervals (100ms) to verify multiple calls
    await new Promise(resolve => setTimeout(resolve, 220));

    assert.ok(callCount >= 2, `Expected >=2 calls in 120ms, got ${callCount}`);

    service.dispose();
  });

  /**
   * Test 2: Stop polling - verify timer stops and cleans up
   */
  it("stop polling prevents further callback invocations", async () => {
    let callCount = 0;
    const config: RemoteChangeConfig = { checkFrequencySeconds: 0.05 }; // 50ms

    const service = new RemoteChangeService(
      async () => {
        callCount++;
      },
      () => config
    );

    service.start();
    await new Promise(resolve => setTimeout(resolve, 60)); // Wait for first call
    const countAfterStart = callCount;

    service.stop();
    assert.strictEqual(
      service.isRunning,
      false,
      "Service should not be running after stop"
    );

    await new Promise(resolve => setTimeout(resolve, 100)); // Wait to verify no more calls

    assert.strictEqual(
      callCount,
      countAfterStart,
      `No new calls after stop (was ${countAfterStart}, now ${callCount})`
    );

    service.dispose();
  });

  it("skips ticks while unfocused and catches up on refocus", async () => {
    let callCount = 0;
    let focused = false;
    let focusListener: (() => void) | undefined;
    let resolveCatchUp: (() => void) | undefined;
    const catchUpSeen = new Promise<void>(r => (resolveCatchUp = r));
    const config: RemoteChangeConfig = { checkFrequencySeconds: 0.05 };

    const service = new RemoteChangeService(
      async () => {
        callCount++;
        resolveCatchUp?.();
      },
      () => config,
      {
        isFocused: () => focused,
        onDidFocus: listener => {
          focusListener = listener;
          return { dispose: () => (focusListener = undefined) };
        }
      }
    );

    service.start();
    await new Promise(r => setTimeout(r, 200)); // ~3 ticks, all unfocused
    assert.strictEqual(callCount, 0, "unfocused ticks must not hit the server");

    focused = true;
    focusListener?.();
    await withTimeout(catchUpSeen, 2000);
    assert.ok(callCount >= 1, "refocus must trigger a catch-up poll");

    service.dispose();
  });

  it("backs off after consecutive failures instead of hammering", async () => {
    let attempts = 0;
    const config: RemoteChangeConfig = { checkFrequencySeconds: 0.05 };

    const service = new RemoteChangeService(
      async () => {
        attempts++;
        throw new Error("server unreachable");
      },
      () => config
    );

    service.start();
    // ~10 tick windows; exponential skip (1, 3, 7...) caps attempts at ~3
    await new Promise(r => setTimeout(r, 550));
    service.dispose();

    assert.ok(attempts >= 2, `must keep retrying eventually (got ${attempts})`);
    assert.ok(
      attempts <= 5,
      `must back off between failures, not retry every tick (got ${attempts})`
    );
  });

  it("refocus catch-up respects the failure backoff", async () => {
    let attempts = 0;
    let focused = true;
    let focusListener: (() => void) | undefined;
    const config: RemoteChangeConfig = { checkFrequencySeconds: 0.05 };

    const service = new RemoteChangeService(
      async () => {
        attempts++;
        throw new Error("server unreachable");
      },
      () => config,
      {
        isFocused: () => focused,
        onDidFocus: listener => {
          focusListener = listener;
          return { dispose: () => (focusListener = undefined) };
        }
      }
    );

    service.start();
    await new Promise(r => setTimeout(r, 80)); // first tick fails, backoff armed
    const afterFirstFailure = attempts;
    assert.ok(afterFirstFailure >= 1);

    focused = false;
    await new Promise(r => setTimeout(r, 80)); // unfocused tick arms missedTick
    focused = true;
    focusListener?.(); // alt-tab back while backoff is active
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(
      attempts,
      afterFirstFailure,
      "refocus must not bypass the backoff against a dead server"
    );

    service.dispose();
  });

  /**
   * Test 3: Error handling - verify errors don't crash polling
   */
  it("polling continues after callback errors", async () => {
    let callCount = 0;
    const config: RemoteChangeConfig = { checkFrequencySeconds: 0.05 }; // 50ms
    let resolveSecondPoll: (() => void) | undefined;
    const secondPollSeen = new Promise<void>(resolve => {
      resolveSecondPoll = resolve;
    });

    const service = new RemoteChangeService(
      async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Simulated polling error");
        }
        if (callCount === 2) {
          resolveSecondPoll?.();
        }
      },
      () => config
    );

    service.start();
    await withTimeout(secondPollSeen, 2000);

    assert.ok(
      callCount >= 2,
      `Polling should continue after error, got ${callCount} calls`
    );
    assert.strictEqual(
      service.isRunning,
      true,
      "Service should still be running after error"
    );

    service.dispose();
  });
});
