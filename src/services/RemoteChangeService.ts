// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { logError } from "../util/errorLogger";

/**
 * Configuration for remote change polling
 */
export type RemoteChangeConfig = {
  /** Check frequency in seconds. 0 = disabled */
  readonly checkFrequencySeconds: number;
};

/**
 * Host-environment hooks, injected so this service stays vscode-free.
 * Both optional: defaults poll every tick (legacy behavior).
 */
export type RemoteChangeServiceOptions = {
  /** Window focus state - unfocused ticks are skipped */
  readonly isFocused?: () => boolean;
  /** Subscribe to focus-gained events for the catch-up poll */
  readonly onDidFocus?: (listener: () => void) => { dispose(): void };
};

/**
 * Service for polling remote SVN changes at configurable intervals.
 */
export class RemoteChangeService {
  private interval?: NodeJS.Timeout;
  private disposed: boolean = false;
  private readonly isFocused: () => boolean;
  private focusSubscription?: { dispose(): void };
  // Set when a tick was skipped for lack of focus - refocus catches up
  private missedTickWhileUnfocused = false;
  // Exponential backoff: after N consecutive failures skip 2^N - 1 ticks
  private consecutiveFailures = 0;
  private ticksToSkip = 0;
  private static readonly MAX_BACKOFF_TICKS = 7;

  /**
   * @param onPoll Callback invoked at each poll interval; MUST return a
   *               promise reflecting success/failure for backoff to work
   * @param getConfig Function to retrieve current config (allows dynamic updates)
   * @param options Focus hooks (see RemoteChangeServiceOptions)
   */
  constructor(
    private readonly onPoll: () => Promise<void> | void,
    private readonly getConfig: () => RemoteChangeConfig,
    options: RemoteChangeServiceOptions = {}
  ) {
    this.isFocused = options.isFocused ?? (() => true);
    if (options.onDidFocus) {
      this.focusSubscription = options.onDidFocus(() => {
        // ticksToSkip guard: alt-tabbing while the server is down must
        // not bypass the failure backoff with a poll per refocus
        if (
          this.missedTickWhileUnfocused &&
          this.isRunning &&
          this.ticksToSkip === 0
        ) {
          this.missedTickWhileUnfocused = false;
          // Catch-up poll ~immediately instead of waiting a full interval
          void this.executePoll();
        }
      });
    }
  }

  private async executePoll(): Promise<void> {
    try {
      await this.onPoll();
      this.consecutiveFailures = 0;
      this.ticksToSkip = 0;
    } catch (err) {
      this.consecutiveFailures++;
      this.ticksToSkip = Math.min(
        2 ** this.consecutiveFailures - 1,
        RemoteChangeService.MAX_BACKOFF_TICKS
      );
      logError("[RemoteChangeService] Polling failed", err);
      // Continue polling despite errors (after backoff)
    }
  }

  start(): void {
    if (this.disposed) {
      throw new Error("Cannot start disposed RemoteChangeService");
    }

    // Clear any existing interval
    this.stop();

    const config = this.getConfig();
    const frequencyMs = config.checkFrequencySeconds * 1000;

    // Don't create interval if disabled
    if (frequencyMs === 0) {
      return;
    }

    // Add 0-10% jitter to prevent simultaneous bursts with multiple repos
    const jitter = Math.random() * 0.1 * frequencyMs;
    const jitteredMs = frequencyMs + jitter;

    this.interval = setInterval(() => {
      // Skip unfocused ticks - badges are invisible; refocus catches up
      if (!this.isFocused()) {
        this.missedTickWhileUnfocused = true;
        return;
      }
      // Failure backoff - don't hammer an unreachable server every tick
      if (this.ticksToSkip > 0) {
        this.ticksToSkip--;
        return;
      }
      void this.executePoll();
    }, jitteredMs);
  }

  stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  restart(): void {
    this.start();
  }

  get isRunning(): boolean {
    return this.interval !== undefined;
  }

  dispose(): void {
    this.stop();
    this.focusSubscription?.dispose();
    this.disposed = true;
  }
}
