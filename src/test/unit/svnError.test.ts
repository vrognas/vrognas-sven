import * as assert from "assert";
import SvnError, { isSvnError } from "../../svnError";
import { getErrorMessage } from "../../util/errorLogger";
import { ISvnErrorData } from "../../common/types";

const sample: ISvnErrorData = {
  message: "Failed to execute svn",
  stderr: "svn: E155004: Working copy locked",
  stderrFormated: "Working copy locked",
  exitCode: 1,
  svnErrorCode: "E155004",
  svnCommand: "commit"
};

suite("SvnError", () => {
  test("is a real Error and preserves svn fields", () => {
    const err = new SvnError(sample);

    assert.ok(err instanceof Error, "should be an Error instance");
    assert.ok(err instanceof SvnError, "should be a SvnError instance");
    assert.strictEqual(err.name, "SvnError");
    assert.strictEqual(err.message, "Failed to execute svn");
    assert.strictEqual(err.svnErrorCode, "E155004");
    assert.strictEqual(err.stderr, "svn: E155004: Working copy locked");
    assert.strictEqual(err.exitCode, 1);
    assert.strictEqual(typeof err.stack, "string");
  });

  test("isSvnError discriminates SvnError from other throwables", () => {
    assert.strictEqual(isSvnError(new SvnError(sample)), true);
    assert.strictEqual(isSvnError(new Error("plain")), false);
    assert.strictEqual(isSvnError({ svnErrorCode: "E155004" }), false);
    assert.strictEqual(isSvnError(undefined), false);
    assert.strictEqual(isSvnError("string"), false);
  });

  test("getErrorMessage returns sanitized svn detail, not a generic fallback", () => {
    const err = new SvnError({
      message: "Failed to execute svn",
      stderrFormated:
        "Unable to connect to https://user@secret.example.com/repo",
      svnErrorCode: "E170013"
    });

    const msg = getErrorMessage(err);

    // informative: surfaces the real reason, not "Unknown error"
    assert.ok(msg.includes("Unable to connect"), `got: ${msg}`);
    // safe: the URL/host is sanitized out
    assert.ok(!msg.includes("secret.example.com"), `leaked host: ${msg}`);

    // non-svn errors keep their existing behavior
    assert.strictEqual(getErrorMessage(new Error("boom")), "boom");
    assert.strictEqual(getErrorMessage("nope"), "nope");
  });
});
