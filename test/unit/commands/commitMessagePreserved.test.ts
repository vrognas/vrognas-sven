import { describe, it, expect, vi } from "vitest";
import { BaseStagedCommitCommand } from "../../../src/commands/baseStagedCommitCommand";

/**
 * A commit failure (network drop, out-of-date, lock conflict) after the
 * QuickPick/conventional message flow used to lose the composed message:
 * it lived only in a local variable and never reached the SCM input box.
 */

vi.mock("../../../src/helpers/commitHelper", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../../src/helpers/commitHelper")>();
  return {
    ...actual,
    runCommitMessageFlow: vi.fn(async () => ({
      cancelled: false,
      message: "feat(x): three quickpick steps of typing",
      commitPaths: ["/ws/a.ts"]
    })),
    executeCommit: vi.fn(async () => {
      throw new Error("svn: E170013: Unable to connect to a repository");
    })
  };
});

describe("commitWithMessageFlow", () => {
  it("preserves the composed message in the input box when the commit fails", async () => {
    const repository = { inputBox: { value: "" } };
    const mockThis = {
      handleRepositoryOperation: vi.fn(
        async (op: () => Promise<void>): Promise<void> => {
          try {
            await op();
          } catch {
            // the real handler shows an error toast; either way the
            // message must already be recoverable from the input box
          }
        }
      )
    };
    const commitWithMessageFlow = (
      BaseStagedCommitCommand.prototype as unknown as Record<string, unknown>
    ).commitWithMessageFlow as (
      this: unknown,
      repository: unknown,
      displayPaths: string[],
      renameMap: Map<string, string>
    ) => Promise<void>;

    await commitWithMessageFlow.call(mockThis, repository, [], new Map());

    expect(repository.inputBox.value).toBe(
      "feat(x): three quickpick steps of typing"
    );
  });
});
