import * as assert from "assert";
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
});
