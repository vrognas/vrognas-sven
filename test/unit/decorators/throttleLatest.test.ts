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
});
