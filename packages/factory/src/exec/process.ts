import { spawn } from "node:child_process";

export const MAX_STDOUT_BYTES = 50 * 1024 * 1024;
export const MAX_STDERR_BYTES = 1024 * 1024;
export const KILL_GRACE_MS = 5000;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  // 출력이 상한을 넘어 잘렸을 때만 설정한다. stdout은 앞부분, stderr는 뒷부분을 남긴다.
  truncated?: { stdout?: true; stderr?: true };
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  input?: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: SpawnOptions,
) => Promise<ProcessResult>;

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch {
    // 이미 종료된 그룹이다.
  }
}

// 중단하면 프로세스 그룹 전체에 SIGTERM을 보내고, 유예 시간 뒤에도 남아 있으면 SIGKILL을 보낸 다음
// 자식이 끝난 뒤에 reject한다.
export const runProcess: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(new Error("The operation was aborted"));
      return;
    }
    const maxOut = opts.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    const maxErr = opts.maxStderrBytes ?? MAX_STDERR_BYTES;
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const truncated: { stdout?: true; stderr?: true } = {};
    let aborted = false;
    let settled = false;
    let escalate: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (escalate) clearTimeout(escalate);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    function onAbort() {
      aborted = true;
      killGroup(child.pid, "SIGTERM");
      escalate = setTimeout(
        () => killGroup(child.pid, "SIGKILL"),
        opts.killGraceMs ?? KILL_GRACE_MS,
      );
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length >= maxOut) {
        truncated.stdout = true;
        return;
      }
      stdout += d;
      if (stdout.length > maxOut) {
        stdout = stdout.slice(0, maxOut);
        truncated.stdout = true;
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      if (stderr.length > maxErr) {
        stderr = stderr.slice(-maxErr);
        truncated.stderr = true;
      }
    });
    child.on("error", (e) => finish(() => reject(e)));
    // 중단된 자식에 stdin을 닫을 때 나는 EPIPE는 무시한다. 결과는 error/close 이벤트로 판단한다.
    child.stdin.on("error", () => undefined);
    // 중단 후에는 파이프를 붙잡고 있는 손자가 있어도 exit에서 정리한다.
    // 리더가 SIGTERM에 종료해도 SIGTERM을 무시하는 손자가 남을 수 있으므로, 정리 전에 그룹에 SIGKILL을 보낸다.
    const settleAborted = () => {
      killGroup(child.pid, "SIGKILL");
      finish(() => reject(new Error("The operation was aborted")));
    };
    child.on("exit", () => {
      if (aborted) settleAborted();
    });
    child.on("close", (code) => {
      if (aborted) settleAborted();
      else
        finish(() =>
          resolve({
            code,
            stdout,
            stderr,
            ...(Object.keys(truncated).length ? { truncated } : {}),
          }),
        );
    });
    child.stdin.end(opts.input ?? "");
  });
