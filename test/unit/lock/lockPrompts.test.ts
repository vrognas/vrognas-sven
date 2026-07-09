import { describe, it, expect, vi, beforeEach } from "vitest";
import { window, commands } from "vscode";
import { Repository } from "../../../src/repository";
import { LockStatus } from "../../../src/common/types";
import type { Resource } from "../../../src/resource";

/**
 * Informed lock UX: the on-open prompt used to go SILENT exactly when a
 * file was locked by someone else, and nothing guarded the first edit of a
 * read-only needs-lock file. Drives the REAL Repository methods via the
 * prototype.call(mockThis) pattern (Repository isn't unit-constructible).
 */

function resourceStub(partial: Partial<Resource>): Resource {
  return partial as Resource;
}

interface MockThis {
  workspaceRoot: string;
  lockPromptShown: Set<string>;
  lockEditPromptShown: Set<string>;
  getResourceFromFile: (p: string) => Resource | undefined;
  hasNeedsLock: (p: string) => Promise<boolean>;
  warnLockContention?: unknown;
}

function makeMockThis(overrides: Partial<MockThis> = {}): MockThis {
  return {
    workspaceRoot: "/ws",
    lockPromptShown: new Set(),
    lockEditPromptShown: new Set(),
    getResourceFromFile: () => undefined,
    hasNeedsLock: async () => false,
    // Real private helper, so the warning content/actions are the real ones
    warnLockContention: (
      Repository.prototype as unknown as Record<string, unknown>
    ).warnLockContention,
    ...overrides
  } as MockThis;
}

const uri = { fsPath: "/ws/data.csv", scheme: "file" } as never;

function proto(method: string) {
  return (Repository.prototype as unknown as Record<string, unknown>)[
    method
  ] as (this: unknown, uri: unknown) => Promise<void>;
}

describe("informed lock UX", () => {
  beforeEach(() => {
    vi.mocked(window.showWarningMessage).mockReset();
    vi.mocked(window.showInformationMessage).mockReset();
    vi.mocked(commands.executeCommand).mockClear();
  });

  it("warns with the owner when opening a file locked by someone else", async () => {
    const mockThis = makeMockThis({
      getResourceFromFile: () =>
        resourceStub({
          lockStatus: LockStatus.O,
          lockOwner: "alice",
          locked: true
        })
    });
    vi.mocked(window.showWarningMessage).mockResolvedValue(
      "Steal Lock" as never
    );

    await proto("promptLockIfNeeded").call(mockThis, uri);

    const msg = vi.mocked(window.showWarningMessage).mock.calls[0]?.[0];
    expect(msg).toContain("alice");
    expect(vi.mocked(commands.executeCommand)).toHaveBeenCalledWith(
      "sven.stealLock",
      uri
    );

    // Once per file per session - a second open stays quiet
    await proto("promptLockIfNeeded").call(mockThis, uri);
    expect(vi.mocked(window.showWarningMessage)).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing needs-lock prompt for unlocked files", async () => {
    const mockThis = makeMockThis({
      hasNeedsLock: async () => true
    });
    vi.mocked(window.showInformationMessage).mockResolvedValue(
      "Lock File" as never
    );

    await proto("promptLockIfNeeded").call(mockThis, uri);

    expect(vi.mocked(window.showInformationMessage)).toHaveBeenCalled();
    expect(vi.mocked(commands.executeCommand)).toHaveBeenCalledWith(
      "sven.lock",
      uri
    );
  });

  it("guards the FIRST edit of a read-only needs-lock file, once", async () => {
    const mockThis = makeMockThis({
      hasNeedsLock: async () => true
    });
    vi.mocked(window.showWarningMessage).mockResolvedValue(
      "Lock File" as never
    );

    await proto("promptLockOnEdit").call(mockThis, uri);

    const msg = vi.mocked(window.showWarningMessage).mock.calls[0]?.[0];
    expect(String(msg)).toMatch(/lock/i);
    expect(vi.mocked(commands.executeCommand)).toHaveBeenCalledWith(
      "sven.lock",
      uri
    );

    // Subsequent keystrokes must not re-prompt
    await proto("promptLockOnEdit").call(mockThis, uri);
    expect(vi.mocked(window.showWarningMessage)).toHaveBeenCalledTimes(1);

    // Files we hold the lock on (K) are never nagged
    const held = makeMockThis({
      getResourceFromFile: () =>
        resourceStub({ lockStatus: LockStatus.K, locked: true })
    });
    await proto("promptLockOnEdit").call(held, uri);
    expect(vi.mocked(window.showWarningMessage)).toHaveBeenCalledTimes(1);
  });
});
