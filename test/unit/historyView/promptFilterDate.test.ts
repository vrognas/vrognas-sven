import { describe, it, expect, vi, beforeEach } from "vitest";
import { window } from "vscode";
import { RepoLogProvider } from "../../../src/historyView/repoLogProvider";

/**
 * `new Date("YYYY-MM-DD")` parses as UTC midnight, so every date bound
 * shifted one day early for users west of UTC. The prompt must parse
 * the input as a LOCAL date.
 */

const promptFilterDate = (
  RepoLogProvider.prototype as unknown as Record<string, unknown>
).promptFilterDate as (this: unknown, f?: Date, t?: Date) => Promise<void>;

describe("promptFilterDate", () => {
  beforeEach(() => {
    vi.mocked(window.showInputBox).mockReset();
    vi.mocked(window.showErrorMessage).mockClear();
  });

  it("parses YYYY-MM-DD as a LOCAL date (no UTC day shift)", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("2024-01-31")
      .mockResolvedValueOnce("");
    const updateFilter = vi.fn();

    await promptFilterDate.call({ filterService: { updateFilter } });

    const { dateFrom, dateTo } = updateFilter.mock.calls[0]![0] as {
      dateFrom?: Date;
      dateTo?: Date;
    };
    expect(dateFrom?.getTime()).toBe(new Date(2024, 0, 31).getTime());
    expect(dateTo).toBeUndefined();
  });

  it("rejects malformed dates without setting a filter", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("31/01/2024")
      .mockResolvedValueOnce("");
    const updateFilter = vi.fn();

    await promptFilterDate.call({ filterService: { updateFilter } });

    expect(updateFilter).not.toHaveBeenCalled();
    expect(vi.mocked(window.showErrorMessage)).toHaveBeenCalled();
  });
});
