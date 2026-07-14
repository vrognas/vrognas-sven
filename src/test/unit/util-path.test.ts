import * as assert from "assert";
import * as path from "path";
import {
  fixPathSeparator,
  normalizePath,
  isDescendant,
  isDescendantForSafety,
  fixPegRevision
} from "../../util";

suite("Util - Path Tests", () => {
  suite("fixPathSeparator", () => {
    test("converts backslashes to forward slashes", () => {
      const expectedDrive =
        path.sep === "\\" ? "c:\\Users\\test" : "C:/Users/test";
      const expectedRelative =
        path.sep === "\\" ? "path\\to\\file.txt" : "path/to/file.txt";
      assert.strictEqual(fixPathSeparator("C:\\Users\\test"), expectedDrive);
      assert.strictEqual(
        fixPathSeparator("path\\to\\file.txt"),
        expectedRelative
      );
    });

    test("handles mixed separators", () => {
      const expected =
        path.sep === "\\"
          ? "c:\\Users\\test\\file.txt"
          : "C:/Users/test/file.txt";
      assert.strictEqual(
        fixPathSeparator("C:\\Users/test\\file.txt"),
        expected
      );
    });

    test("leaves forward slashes unchanged", () => {
      const expectedUnix =
        path.sep === "\\" ? "\\usr\\local\\bin" : "/usr/local/bin";
      const expectedRelative =
        path.sep === "\\" ? "path\\to\\file" : "path/to/file";
      assert.strictEqual(fixPathSeparator("/usr/local/bin"), expectedUnix);
      assert.strictEqual(fixPathSeparator("path/to/file"), expectedRelative);
    });

    test("handles empty string", () => {
      assert.strictEqual(fixPathSeparator(""), "");
    });
  });

  suite("normalizePath", () => {
    test("converts backslashes and lowercases", () => {
      const expectedDrive =
        path.sep === "\\" ? "c:\\users\\test" : "C:/Users/Test";
      const expectedRelative =
        path.sep === "\\" ? "path\\to\\file" : "PATH/TO/FILE";
      assert.strictEqual(normalizePath("C:\\Users\\Test"), expectedDrive);
      assert.strictEqual(normalizePath("PATH\\TO\\FILE"), expectedRelative);
    });

    test("handles forward slashes", () => {
      const expected =
        path.sep === "\\" ? "\\usr\\local\\bin" : "/Usr/Local/Bin";
      assert.strictEqual(normalizePath("/Usr/Local/Bin"), expected);
    });

    test("handles empty string", () => {
      assert.strictEqual(normalizePath(""), "");
    });
  });

  suite("isDescendant", () => {
    test("returns true for direct children", () => {
      assert.strictEqual(isDescendant("/parent", "/parent/child"), true);
      assert.strictEqual(isDescendant("C:/Users", "C:/Users/test"), true);
    });

    test("returns true for nested descendants", () => {
      assert.strictEqual(
        isDescendant("/parent", "/parent/child/grandchild"),
        true
      );
      assert.strictEqual(isDescendant("C:/", "C:/Users/test/file.txt"), true);
    });

    test("returns false for non-descendants", () => {
      assert.strictEqual(isDescendant("/parent", "/other"), false);
      assert.strictEqual(isDescendant("/parent", "/parent-sibling"), false);
      assert.strictEqual(isDescendant("C:/Users", "C:/Program Files"), false);
    });

    test("returns false for parent itself", () => {
      assert.strictEqual(isDescendant("/parent", "/parent"), true);
    });

    test("handles case sensitivity on Windows-style paths", () => {
      const expected = path.sep === "\\";
      assert.strictEqual(isDescendant("C:/Users", "c:/users/test"), expected);
    });

    test("handles trailing slashes", () => {
      assert.strictEqual(isDescendant("/parent/", "/parent/child"), true);
      assert.strictEqual(isDescendant("/parent", "/parent/child/"), true);
    });
  });

  suite("isDescendantForSafety", () => {
    test("folds case on macOS", () => {
      assert.strictEqual(
        isDescendantForSafety(
          "/Users/me/WC/Data",
          "/users/me/wc/data/changed.txt",
          "darwin"
        ),
        true
      );
    });

    test("preserves case on Linux", () => {
      assert.strictEqual(
        isDescendantForSafety(
          "/home/me/WC/Data",
          "/home/me/wc/data/changed.txt",
          "linux"
        ),
        false
      );
    });

    test("still rejects prefix siblings", () => {
      assert.strictEqual(
        isDescendantForSafety(
          "/Users/me/WC/Data",
          "/users/me/wc/database/changed.txt",
          "darwin"
        ),
        false
      );
    });
  });

  suite("fixPegRevision", () => {
    test("escapes @ symbol in paths", () => {
      assert.strictEqual(fixPegRevision("file@2x.png"), "file@2x.png@");
      assert.strictEqual(
        fixPegRevision("path/to/file@.txt"),
        "path/to/file@.txt@"
      );
    });

    test("leaves paths without @ unchanged", () => {
      assert.strictEqual(fixPegRevision("file.txt"), "file.txt");
      assert.strictEqual(
        fixPegRevision("path/to/file.txt"),
        "path/to/file.txt"
      );
    });

    test("handles multiple @ symbols", () => {
      assert.strictEqual(fixPegRevision("file@2@3.txt"), "file@2@3.txt@");
    });

    test("handles empty string", () => {
      assert.strictEqual(fixPegRevision(""), "");
    });
  });
});
