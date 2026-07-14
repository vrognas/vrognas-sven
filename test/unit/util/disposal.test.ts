import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeBestEffort, runTeardown } from "../../../src/util/disposal";
import * as errorLogger from "../../../src/util/errorLogger";

describe("best-effort teardown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attempts every disposal when one throws", () => {
    const calls: number[] = [];
    const error = new Error("middle failed");
    const log = vi.spyOn(errorLogger, "logError").mockImplementation(() => {});

    disposeBestEffort(
      [
        { dispose: () => calls.push(1) },
        {
          dispose: () => {
            calls.push(2);
            throw error;
          }
        },
        { dispose: () => calls.push(3) }
      ],
      "cleanup failed"
    );

    expect(calls).toEqual([1, 2, 3]);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("cleanup failed", error);
  });

  it("supports optional resources and isolated actions", () => {
    const calls: string[] = [];
    vi.spyOn(errorLogger, "logError").mockImplementation(() => {});

    disposeBestEffort(
      new Set([undefined, { dispose: () => calls.push("resource") }])
    );
    runTeardown("action failed", () => calls.push("action"));

    expect(calls).toEqual(["resource", "action"]);
  });
});
