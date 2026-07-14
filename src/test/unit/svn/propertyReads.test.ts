import * as assert from "assert";
import * as path from "path";
import { Repository as SvnRepository } from "../../../svnRepository";
import SvnError from "../../../svnError";

function failingRepository(error: Error): any {
  const repository: any = Object.create(SvnRepository.prototype);
  repository.validatePath = (filePath: string) => filePath;
  repository.exec = async () => {
    throw error;
  };
  return repository;
}

suite("svnRepository property read errors", () => {
  test("structured W200017 means property absent", async () => {
    const repository = failingRepository(
      new SvnError({ svnErrorCode: "W200017" })
    );

    assert.strictEqual(
      await repository.getProperty("svn:needs-lock", "file.txt"),
      null
    );
    assert.deepStrictEqual(
      await repository.getAllPropertyValues("svn:eol-style"),
      new Map()
    );
    assert.deepStrictEqual(await repository.getAllIgnorePatterns(), new Map());
  });

  test("single and recursive reads propagate operational errors", async () => {
    const failure = new SvnError({
      message: "offline",
      svnErrorCode: "E170013"
    });
    const repository = failingRepository(failure);

    await assert.rejects(
      repository.getProperty("svn:needs-lock", "file.txt"),
      error => error === failure
    );
    await assert.rejects(
      repository.getAllPropertyValues("svn:eol-style"),
      error => error === failure
    );
    assert.deepStrictEqual(await repository.getAllIgnorePatterns(), new Map());
  });

  test("batched property reads propagate operational errors", async () => {
    const failure = new SvnError({
      message: "working copy locked",
      svnErrorCode: "E155004"
    });
    const repository = failingRepository(failure);

    await assert.rejects(
      repository.getAllProperties(),
      error => error === failure
    );
  });

  test("recursive property APIs share XML commands and parsing", async () => {
    const calls: string[][] = [];
    const repository: any = Object.create(SvnRepository.prototype);
    repository.validatePath = (value: string) => value;
    repository.exec = async (args: string[]) => {
      calls.push(args);
      return {
        exitCode: 0,
        stderr: "",
        stdout: `<properties>
  <target path="src/file.txt">
    <property name="svn:needs-lock"/>
    <property name="svn:eol-style">LF</property>
    <property name="svn:mime-type">text/plain</property>
  </target>
  <target path="build">
    <property name="svn:ignore">dist\n*.tmp</property>
  </target>
</properties>`
      };
    };

    assert.deepStrictEqual(
      await repository.getAllPropertyValues("svn:eol-style"),
      new Map([["src/file.txt", "LF"]])
    );
    const all = await repository.getAllProperties();
    assert.deepStrictEqual(all.needsLock, new Set(["src/file.txt"]));
    assert.deepStrictEqual(all.eolStyle, new Map([["src/file.txt", "LF"]]));
    assert.deepStrictEqual(
      all.mimeType,
      new Map([["src/file.txt", "text/plain"]])
    );
    assert.deepStrictEqual(
      await repository.getAllIgnorePatterns(),
      new Map([["build", ["dist", "*.tmp"]]])
    );
    assert.deepStrictEqual(await repository.getPropertyList("src/file.txt"), [
      "svn:needs-lock",
      "svn:eol-style",
      "svn:mime-type",
      "svn:ignore"
    ]);
    assert.deepStrictEqual(calls, [
      ["propget", "svn:eol-style", "-R", "--xml", "."],
      ["proplist", "-R", "-v", "--xml", "."],
      ["propget", "svn:ignore", "-R", "--xml", "."],
      ["proplist", "--xml", "src/file.txt"]
    ]);
  });

  test("recursive propget keeps its relative-path contract", async () => {
    const workspaceRoot = path.join(path.parse(process.cwd()).root, "wc");
    const absoluteTarget = path
      .join(workspaceRoot, "src", "file.txt")
      .replace(/\\/g, "/");
    const repository: any = Object.create(SvnRepository.prototype);
    repository.workspaceRoot = workspaceRoot;
    repository.exec = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: `<properties><target path="${absoluteTarget}"><property name="svn:eol-style">LF</property></target></properties>`
    });

    assert.deepStrictEqual(
      await repository.getAllPropertyValues("svn:eol-style"),
      new Map([[path.join("src", "file.txt"), "LF"]])
    );
  });
});
