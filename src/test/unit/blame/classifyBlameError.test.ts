import * as assert from "assert";
import { classifyBlameError } from "../../../blame/classifyBlameError";
import SvnError from "../../../svnError";

suite("classifyBlameError", () => {
  test("classifies by error code across message, stderr and svnErrorCode", () => {
    // untracked via stderr
    assert.strictEqual(
      classifyBlameError({ stderr: "svn: W155010: node not found" }),
      "untracked"
    );
    // untracked via a real SvnError svnErrorCode
    assert.strictEqual(
      classifyBlameError(new SvnError({ svnErrorCode: "E155007" })),
      "untracked"
    );
    // auth via message text
    assert.strictEqual(
      classifyBlameError(new Error("Authentication failed")),
      "auth"
    );
    // network via code
    assert.strictEqual(
      classifyBlameError({ stderr: "svn: E170013: Unable to connect" }),
      "network"
    );
  });

  test("returns 'other' for unrelated errors and non-objects", () => {
    assert.strictEqual(classifyBlameError(new Error("disk full")), "other");
    assert.strictEqual(classifyBlameError("boom"), "other");
    assert.strictEqual(classifyBlameError(undefined), "other");
  });

  test("untracked takes priority over auth/network when codes co-occur", () => {
    // A response mentioning both an untracked code and a network code
    // should skip silently (untracked wins), matching prior behavior.
    assert.strictEqual(
      classifyBlameError({ stderr: "svn: E155007 ... svn: E170013" }),
      "untracked"
    );
  });
});
