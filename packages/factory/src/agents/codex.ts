import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { estimateCostUsd } from "../config/agents";
import { errorMessage } from "./budget";
import { failedResult, type AgentAdapter, type AgentResult, type AgentTask } from "./types";

export interface CodexTurn {
  finalResponse: string;
  items: { type: string }[];
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface CodexLike {
  startThread(options: ThreadOptions): {
    run(input: string, opts?: { signal?: AbortSignal }): Promise<CodexTurn>;
  };
}

// 턴 수로 세는 항목: 실제 행동(명령 실행, 파일 변경, MCP 호출). 추론·메시지·todo·오류는 제외한다.
const ACTION_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call"]);

export function codexThreadOptions(task: AgentTask, model: string): ThreadOptions {
  return {
    model,
    workingDirectory: task.cwd,
    sandboxMode: task.readOnly ? "read-only" : "workspace-write",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
    webSearchMode: "disabled",
  };
}

export function createCodexAdapter(opts: {
  model: string;
  env: Record<string, string>;
  price: { input: number; output: number } | null;
  codex?: CodexLike;
}): AgentAdapter {
  // env를 주면 Codex CLI는 process.env를 상속하지 않는다. scrubEnv() 결과만 넘긴다.
  const codex: CodexLike =
    opts.codex ?? new Codex({ apiKey: opts.env.CODEX_API_KEY, env: opts.env });
  return {
    name: "codex",
    async run(task) {
      try {
        const signal = task.signal;
        const turn = await codex
          .startThread(codexThreadOptions(task, opts.model))
          .run(task.prompt, signal ? { signal } : {});
        const usage = {
          inputTokens: turn.usage?.input_tokens ?? 0,
          outputTokens: turn.usage?.output_tokens ?? 0,
        };
        const result: AgentResult = {
          ok: true,
          summary: turn.finalResponse,
          model: opts.model,
          turns: turn.items.filter((i) => ACTION_ITEMS.has(i.type)).length,
          usage,
        };
        const cost = estimateCostUsd(opts.price, usage);
        if (cost !== undefined) result.costUsd = cost;
        return result;
      } catch (e) {
        return failedResult(
          opts.model,
          task.signal?.aborted ? "timeout" : "engine_error",
          errorMessage(e),
        );
      }
    },
  };
}
