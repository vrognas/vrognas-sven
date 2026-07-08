import * as assert from "assert";
import { Uri } from "vscode";
import { tempSvnFs } from "../temp_svn_fs";
import { basename, dirname } from "path";

suite("Test temp svn fs", () => {
  test("Temp files matches expected", async () => {
    const svnUri = Uri.parse("http://example.com/svn/test/trunk/test.js");

    const revisionUri = tempSvnFs.createTempSvnRevisionFile(
      svnUri,
      "30",
      "test content"
    );

    assert.equal(basename(revisionUri.fsPath), "r30_test.js");
    assert.match(dirname(revisionUri.fsPath), /[\\\/][a-f0-9]{32}$/);
  });

  test("Temp file is created", async () => {
    const svnUri = Uri.parse("http://example.com/svn/test/trunk/test.js");

    const uri = tempSvnFs.createTempSvnRevisionFile(
      svnUri,
      "30",
      "test content"
    );

    assert.ok(tempSvnFs.stat(uri));
  });

  test("Temp contents are correct", async () => {
    const svnUri = Uri.parse("http://example.com/svn/test/trunk/test.js");

    const revisionUri = tempSvnFs.createTempSvnRevisionFile(
      svnUri,
      "30",
      "test content"
    );

    assert.equal(tempSvnFs.readFile(revisionUri), "test content");
  });
});
