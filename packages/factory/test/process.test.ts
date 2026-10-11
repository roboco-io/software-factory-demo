import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("kills the whole process group on abort", async () => {
    const controller = new AbortController();
    const pidFile = path.join(os.tmpdir(), `grandchild-${process.pid}-${Date.now()}`);
    const p = runProcess("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], {
      cwd: process.cwd(),
      env,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim()).toBeTruthy(),
    );
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    controller.abort();
    await expect(p).rejects.toThrow();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    fs.rmSync(pidFile);
  });

  it("kills a grandchild that ignores SIGTERM after the leader exits on SIGTERM", async () => {
    const controller = new AbortController();
    const pidFile = path.join(os.tmpdir(), `ignore-term-${process.pid}-${Date.now()}`);
    try {
      const p = runProcess("sh", ["-c", `(trap "" TERM; sleep 30) & echo $! > ${pidFile}; wait`], {
        cwd: process.cwd(),
        env,
        signal: controller.signal,
      });
      await vi.waitFor(() =>
        expect(fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim()).toBeTruthy(),
      );
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      controller.abort();
      await expect(p).rejects.toThrow();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const controller = new AbortController();
    const p = runProcess("sh", ["-c", 'trap "" TERM; sleep 30'], {
      cwd: process.cwd(),
      env,
      signal: controller.signal,
      killGraceMs: 200,
    });
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects immediately for an already aborted signal", async () => {
    await expect(
      runProcess("sh", ["-c", "true"], { cwd: process.cwd(), env, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  it("caps stdout (keeps head) and stderr (keeps tail) and marks truncation", async () => {
    const r = await runProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write('a'.repeat(100)+'b'.repeat(100)); process.stderr.write('x'.repeat(100)+'y'.repeat(10))",
      ],
      { cwd: process.cwd(), env, maxStdoutBytes: 50, maxStderrBytes: 20 },
    );
    expect(r.stdout).toBe("a".repeat(50));
    expect(r.stderr).toBe("x".repeat(10) + "y".repeat(10));
    expect(r.truncated).toEqual({ stdout: true, stderr: true });
  });
});
