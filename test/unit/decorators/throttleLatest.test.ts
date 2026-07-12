import { describe, expect, it } from "vitest";
import { throttleLatest } from "../../../src/decorators";

describe("throttleLatest", () => {
  it("runs the latest queued arguments", async () => {
    const releases: Array<() => void> = [];

    class Subject {
      readonly calls: string[] = [];

      @throttleLatest
      async run(value: string): Promise<string> {
        this.calls.push(value);
        await new Promise<void>(resolve => releases.push(resolve));
        return value;
      }
    }

    const subject = new Subject();
    const first = subject.run("A");
    const second = subject.run("B");
    const latest = subject.run("C");

    expect(subject.calls).toEqual(["A"]);
    releases.shift()!();
    await first;
    await Promise.resolve();
    expect(subject.calls).toEqual(["A", "C"]);

    releases.shift()!();
    await expect(second).resolves.toBe("C");
    await expect(latest).resolves.toBe("C");
  });

  it("runs queued work after rejection and recovers", async () => {
    const controls: Array<{
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];

    class Subject {
      readonly calls: string[] = [];

      @throttleLatest
      async run(value: string): Promise<string> {
        this.calls.push(value);
        await new Promise<void>((resolve, reject) =>
          controls.push({ resolve, reject })
        );
        return value;
      }
    }

    const subject = new Subject();
    const first = subject.run("A");
    const queued = subject.run("B");
    const queuedResult = queued.then(
      value => ({ value }),
      error => ({ error })
    );

    controls[0].reject(new Error("A failed"));
    await expect(first).rejects.toThrow("A failed");
    await Promise.resolve();
    expect(subject.calls).toEqual(["A", "B"]);

    controls[1].resolve();
    await expect(queuedResult).resolves.toEqual({ value: "B" });

    const current = subject.run("C");
    const latest = subject.run("D");
    controls[2].resolve();
    await current;
    await Promise.resolve();
    expect(subject.calls).toEqual(["A", "B", "C", "D"]);
    controls[3].resolve();
    await expect(latest).resolves.toBe("D");
  });
});
