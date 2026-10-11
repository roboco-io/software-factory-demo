import { describe, expect, it } from "vitest";
import { runProcess } from "../src/exec/process";

const env = { PATH: process.env.PATH ?? "", FOO: "bar" };

describe("runProcess", () => {
  it("collects stdout, stderr and the exit code with the given env only", async () => {
    const r = await runProcess(
      process.execPath,
      [
        "-e",
        "console.log(process.env.FOO); console.error(process.env.HOME ?? 'nohome'); process.exit(3)",
      ],
      { cwd: process.cwd(), env },
    );
    expect(r).toEqual({ code: 3, stdout: "bar\n", stderr: "nohome\n" });
  });

  it("passes stdin input", async () => {
    const r = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      cwd: process.cwd(),
      env,
      input: "hello",
    });
    expect(r.stdout).toBe("hello");
  });

  it("rejects when aborted", async () => {
    const controller = new AbortController();
    const p = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      env,
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toThrow();
  });
});
