import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  input?: string;
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: SpawnOptions,
) => Promise<ProcessResult>;

export const runProcess: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    // 중단된 자식에 stdin을 닫을 때 나는 EPIPE는 무시한다. 결과는 error/close 이벤트로 판단한다.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
