import { describe, it, expect } from "vitest";
import { validateLockComment } from "../../../src/validation";

describe("validateLockComment", () => {
  it("accepts valid comments", () => {
    expect(validateLockComment("Editing data file")).toBe(true);
    expect(validateLockComment("Work in progress")).toBe(true);
    expect(validateLockComment("Bug fix #123")).toBe(true);
  });

  it("accepts empty string", () => {
    expect(validateLockComment("")).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(validateLockComment(null as any)).toBe(false);
    expect(validateLockComment(undefined as any)).toBe(false);
    expect(validateLockComment(123 as any)).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(validateLockComment("test; rm -rf")).toBe(false);
    expect(validateLockComment("test && echo")).toBe(false);
    expect(validateLockComment("test | grep")).toBe(false);
    expect(validateLockComment("test $(cat)")).toBe(false);
    expect(validateLockComment("test `whoami`")).toBe(false);
    expect(validateLockComment("test { }")).toBe(false);
    expect(validateLockComment("test()")).toBe(false);
    expect(validateLockComment("test\\n")).toBe(false);
  });

  it("accepts normal punctuation", () => {
    expect(validateLockComment("It's working!")).toBe(true);
    expect(validateLockComment("Fix: issue #123")).toBe(true);
    expect(validateLockComment("Update [draft]")).toBe(true);
    expect(validateLockComment("Version 1.0.0")).toBe(true);
  });
});
