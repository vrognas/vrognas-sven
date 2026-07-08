import * as assert from "assert";
import { ICpOptions, ISvnInfo, ISvnOptions, Status } from "../common/types";
import { Svn } from "../svn";
import { Repository } from "../svnRepository";

suite("Svn Repository Tests", () => {
  let svn: Svn | null;
  const options = {
    svnPath: "svn",
    version: "1.9"
  } as ISvnOptions;

  suiteSetup(async () => {
    // svn = new Svn(options);
  });

  suiteTeardown(() => {
    svn = null;
  });

  test("create() returns a real Repository instance", async () => {
    svn = new Svn(options);
    // Prefetched info skips the initial `svn info` fetch, so no process runs.
    const info = { url: "https://example.com/repo" } as unknown as ISvnInfo;
    const repository = await Repository.create(svn, "/tmp", "/tmp", info);

    // The old async-returning-constructor cast produced a Promise disguised as
    // a Repository; create() must hand back a genuine instance.
    assert.ok(repository instanceof Repository);
    assert.strictEqual(repository.root, "/tmp");
    assert.strictEqual(repository.workspaceRoot, "/tmp");
  });

  test("Test getStatus", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");
    repository.exec = async (_args: string[], _options?: ICpOptions) => {
      return {
        exitCode: 1,
        stderr: "",
        stdout: `<?xml version="1.0" encoding="UTF-8"?> <status> <target path="."> <entry path="test.php"> <wc-status item="modified" revision="19" props="none"> <commit revision="19"> <author>chris</author> <date>2018-09-06T17:26:59.815389Z</date> </commit> </wc-status> </entry> <entry path="newfiletester.php"> <wc-status item="modified" revision="19" props="none"> <commit revision="19"> <author>chris</author> <date>2018-09-06T17:26:59.815389Z</date> </commit> </wc-status> </entry> <entry path="added.php"> <wc-status item="unversioned" props="none"> </wc-status> </entry> <against revision="19"/> </target> </status>`
      };
    };

    const status = await repository.getStatus({});

    assert.equal(status[0]!.path, "test.php");
    assert.equal(status[1]!.path, "newfiletester.php");
    assert.equal(status[2]!.path, "added.php");
  });

  test("Test rename", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");
    repository.exec = async (args: string[], _options?: ICpOptions) => {
      assert.equal(args[0]!.includes("rename"), true);
      assert.equal(args[1]!.includes("test.php"), true);
      assert.equal(args[2]!.includes("tester.php"), true);

      return {
        exitCode: 1,
        stderr: "",
        stdout: `
        A         test.php
        D         tester.php
        `
      };
    };

    await repository.rename("test.php", "tester.php");
  });

  test("Test addChangelist validation - invalid name", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");

    try {
      await repository.addChangelist(["test.php"], "invalid@name");
      assert.fail("Should throw on invalid changelist name");
    } catch (e: unknown) {
      assert.match((e as Error).message, /Invalid changelist name/);
    }
  });

  test("Test addChangelist validation - valid name", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");
    repository.exec = async (args: string[]) => {
      assert.equal(args[0], "changelist");
      assert.equal(args[1], "valid_name-123");
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    await repository.addChangelist(["test.php"], "valid_name-123");
  });

  test("Test merge validation - invalid accept action", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");

    try {
      await repository.merge("trunk", false, "invalid_action");
      assert.fail("Should throw on invalid accept action");
    } catch (e: unknown) {
      assert.match((e as Error).message, /Invalid accept action/);
    }
  });

  test("Test merge validation - valid accept action", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");
    repository.getRepoUrl = async () => "http://repo/svn";
    repository.exec = async (args: string[]) => {
      assert.equal(args[0], "merge");
      assert.equal(args[1], "--accept");
      assert.equal(args[2], "postpone");
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    await repository.merge("trunk", false, "postpone");
  });

  test("Test plainLogByText validation - invalid pattern", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");

    try {
      await repository.plainLogByText("pattern;rm -rf /");
      assert.fail("Should throw on invalid search pattern");
    } catch (e: unknown) {
      assert.match((e as Error).message, /Invalid search pattern/);
    }
  });

  test("Test plainLogByText validation - valid pattern", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");
    repository.exec = async (args: string[]) => {
      assert.equal(args[0], "log");
      assert.equal(args[1], "--search");
      assert.equal(args[2], "bugfix");
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    await repository.plainLogByText("bugfix");
  });

  test("Test getStatus with externals (parallel fetch)", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");

    let getInfoCallCount = 0;

    repository.exec = async (args: string[], _options?: ICpOptions) => {
      if (args[0] === "info") {
        getInfoCallCount++;
        const idx = getInfoCallCount;
        await new Promise(r => setTimeout(r, 50));
        return {
          exitCode: 0,
          stderr: "",
          stdout: `<?xml version="1.0"?><info><entry path="ext${idx}" revision="${idx}"><url>https://example.com/ext${idx}</url><repository><root>https://example.com</root><uuid>uuid-${idx}</uuid></repository><commit revision="${idx}"><author>test</author><date>2026-01-01T00:00:00.000000Z</date></commit></entry></info>`
        };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: `<?xml version="1.0"?><status><target path="."><entry path="ext1"><wc-status item="external"/></entry><entry path="ext2"><wc-status item="external"/></entry><entry path="ext3"><wc-status item="external"/></entry></target></status>`
      };
    };

    const status = await repository.getStatus({ fetchExternalUuids: true });

    // Verify all 3 externals processed
    const externals = status.filter((s: any) => s.status === Status.EXTERNAL);
    assert.equal(externals.length, 3);

    // Verify getInfo called 3 times
    assert.equal(getInfoCallCount, 3);

    // Verify UUIDs assigned
    const withUuid = status.filter((s: any) => s.repositoryUuid);
    assert.equal(withUuid.length, 3);
  });

  test("Test getInfo LRU cache evicts oldest when max size reached", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");

    let execCount = 0;
    repository.exec = async (args: string[]) => {
      if (args[0] === "info") {
        execCount++;
        return {
          exitCode: 0,
          stderr: "",
          stdout: `<?xml version="1.0"?><info><entry><url>${args[1] || "root"}</url><repository><uuid>test-uuid</uuid><root>http://test</root></repository><revision>1</revision></entry></info>`
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    // Fill cache with 501 entries
    for (let i = 0; i < 501; i++) {
      await repository.getInfo(`file${i}.txt`);
    }

    // First entry should be evicted, requires re-exec
    const beforeCount = execCount;
    await repository.getInfo("file0.txt");
    const afterCount = execCount;

    assert.ok(
      afterCount > beforeCount,
      "First entry should have been evicted and require re-fetch"
    );
  });

  test("Test getInfo LRU cache updates access time on hit", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");

    let execCount = 0;
    repository.exec = async (args: string[]) => {
      if (args[0] === "info") {
        execCount++;
        return {
          exitCode: 0,
          stderr: "",
          stdout: `<?xml version="1.0"?><info><entry><url>${args[1] || "root"}</url><repository><uuid>test-uuid</uuid><root>http://test</root></repository><revision>1</revision></entry></info>`
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    // Add first file
    await repository.getInfo("first.txt");

    // Fill cache with 499 more entries
    for (let i = 1; i < 500; i++) {
      await repository.getInfo(`file${i}.txt`);
    }

    // Access first.txt again (updates its access time)
    const beforeCount = execCount;
    await repository.getInfo("first.txt");
    assert.equal(execCount, beforeCount, "Should use cached value");

    // Add one more entry (501st) - first.txt should NOT be evicted
    await repository.getInfo("file500.txt");

    // first.txt should still be cached
    const beforeCount2 = execCount;
    await repository.getInfo("first.txt");
    assert.equal(
      execCount,
      beforeCount2,
      "first.txt should still be cached after being accessed"
    );
  });

  test("Test getInfo LRU cache respects 500 entry limit", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tpm");

    let execCount = 0;
    repository.exec = async (args: string[]) => {
      if (args[0] === "info") {
        execCount++;
        return {
          exitCode: 0,
          stderr: "",
          stdout: `<?xml version="1.0"?><info><entry><url>${args[1] || "root"}</url><repository><uuid>test-uuid</uuid><root>http://test</root></repository><revision>1</revision></entry></info>`
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    // Fill cache to exactly 500 entries
    for (let i = 0; i < 500; i++) {
      await repository.getInfo(`file${i}.txt`);
    }

    // All 500 should be cached
    const beforeCount = execCount;
    await repository.getInfo("file0.txt");
    await repository.getInfo("file250.txt");
    await repository.getInfo("file499.txt");
    assert.equal(execCount, beforeCount, "All 500 entries should be cached");
  });

  test("hasRemoteChanges: Returns false when BASE == HEAD (no changes)", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    // Mock log output when BASE == HEAD (no new revisions)
    repository.exec = async (args: string[]) => {
      assert.equal(args[0], "log");
      assert.equal(args[1], "-r");
      // Descending: --limit 1 must return the YOUNGEST revision
      assert.equal(args[2], "HEAD:BASE");
      assert.equal(args[3], "--limit");
      assert.equal(args[4], "1");
      assert.equal(args[5], "--xml");

      return {
        exitCode: 0,
        stderr: "",
        stdout: `<?xml version="1.0" encoding="UTF-8"?>
<log>
</log>`
      };
    };

    const probe = await repository.hasRemoteChanges();
    assert.strictEqual(
      probe.hasChanges,
      false,
      "Should return false when no new revisions"
    );
  });

  test("hasRemoteChanges: Returns true when BASE < HEAD (new revisions)", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    // Mock log output when BASE < HEAD (new revisions exist)
    repository.exec = async (args: string[]) => {
      assert.equal(args[0], "log");
      return {
        exitCode: 0,
        stderr: "",
        stdout: `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="42">
<author>user</author>
<date>2025-11-12T10:00:00.000000Z</date>
<msg>New remote change</msg>
</logentry>
</log>`
      };
    };

    const probe = await repository.hasRemoteChanges();
    assert.strictEqual(
      probe.hasChanges,
      true,
      "Should return true when new revisions exist"
    );
    assert.strictEqual(probe.youngestRevision, 42);
  });

  test("getStatus: Skips status check when no remote changes", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    let logCalled = false;
    let statusCalled = false;

    repository.exec = async (args: string[]) => {
      if (args[0] === "log") {
        logCalled = true;
        return {
          exitCode: 0,
          stderr: "",
          stdout: `<?xml version="1.0"?><log></log>`
        };
      }
      if (args[0] === "stat") {
        statusCalled = true;
        return {
          exitCode: 0,
          stderr: "",
          stdout: `<?xml version="1.0"?><status><target path="."><against revision="19"/></target></status>`
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    await repository.getStatus({ checkRemoteChanges: true });

    assert.strictEqual(logCalled, true, "Should call log to check for changes");
    assert.strictEqual(
      statusCalled,
      false,
      "Should NOT call status when no changes"
    );
  });

  test("commitFiles: Throws when exec fails", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    repository.exec = async () => {
      throw new Error("SVN commit failed");
    };

    try {
      // Message with newline triggers temp file usage
      await repository.commitFiles("Line1\nLine2", ["test.txt"]);
      assert.fail("Should throw error");
    } catch (e: unknown) {
      assert.match((e as Error).message, /SVN commit failed/);
    }
  });

  test("commitFiles: Returns commit message on success", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    repository.exec = async (args: string[]) => {
      assert.equal(args[0], "commit");
      return {
        exitCode: 0,
        stderr: "",
        stdout: "Sending        test.txt\nCommitted revision 42."
      };
    };

    const result = await repository.commitFiles("test message", ["test.txt"]);
    assert.match(result, /revision 42/);
  });

  test("commitFiles: Uses temp file for multiline messages", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    let usedTempFile = false;
    repository.exec = async (args: string[]) => {
      if (args.includes("-F")) {
        usedTempFile = true;
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: "Committed revision 42."
      };
    };

    await repository.commitFiles("Line1\nLine2", ["test.txt"]);
    assert.strictEqual(
      usedTempFile,
      true,
      "Should use -F flag for multiline message"
    );
  });

  test("getScopedStatus: Fetches status for specific path with depth", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    let capturedArgs: string[] = [];
    repository.exec = async (args: string[]) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        stderr: "",
        stdout: `<?xml version="1.0"?><status><target path="src"><entry path="src/file1.ts"><wc-status item="modified" props="none"/></entry></target></status>`
      };
    };

    const status = await repository.getScopedStatus("src", "immediates");

    assert.ok(capturedArgs.includes("stat"), "Should call stat command");
    assert.ok(capturedArgs.includes("--depth"), "Should include --depth flag");
    assert.ok(
      capturedArgs.includes("immediates"),
      "Should use specified depth"
    );
    assert.equal(status.length, 1);
    assert.equal(status[0]!.path, "src/file1.ts");
  });

  test("getScopedStatus: Works with infinity depth", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    let capturedArgs: string[] = [];
    repository.exec = async (args: string[]) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        stderr: "",
        stdout: `<?xml version="1.0"?><status><target path="lib"><entry path="lib/a.ts"><wc-status item="added" props="none"/></entry><entry path="lib/sub/b.ts"><wc-status item="modified" props="none"/></entry></target></status>`
      };
    };

    const status = await repository.getScopedStatus("lib", "infinity");

    assert.ok(
      capturedArgs.includes("infinity"),
      "Should use infinity depth for recursive"
    );
    assert.equal(status.length, 2);
  });

  test("getScopedStatus: Empty depth returns only folder status", async () => {
    svn = new Svn(options);
    const repository = new Repository(svn, "/tmp", "/tmp");

    let capturedArgs: string[] = [];
    repository.exec = async (args: string[]) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        stderr: "",
        stdout: `<?xml version="1.0"?><status><target path="docs"></target></status>`
      };
    };

    const status = await repository.getScopedStatus("docs", "empty");

    assert.ok(capturedArgs.includes("empty"), "Should use empty depth");
    assert.equal(status.length, 0);
  });
});
