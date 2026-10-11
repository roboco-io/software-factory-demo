import {
  query as sdkQuery,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "./budget";
import {
  failedResult,
  type AgentAdapter,
  type AgentResult,
  type AgentTask,
  type FailureReason,
} from "./types";

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep"];
export const CLAUDE_WRITE_DENY = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

export function claudeOptions(
  task: AgentTask,
  model: string,
  env: Record<string, string>,
  abortController: AbortController,
): Options {
  const base: Options = {
    model,
    cwd: task.cwd,
    maxTurns: task.budget.maxTurns,
    abortController,
    env,
    // CLAUDE.md(@AGENTS.md)를 읽게 한다. 사용자·로컬 설정은 CI에서 읽지 않는다.
    settingSources: ["project"],
  };
  if (task.budget.maxUsd !== undefined) base.maxBudgetUsd = task.budget.maxUsd;
  if (task.readOnly) {
    return {
      ...base,
      allowedTools: CLAUDE_READ_TOOLS,
      disallowedTools: CLAUDE_WRITE_DENY,
      permissionMode: "dontAsk",
    };
  }
  // CI 러너 한정. 쓰기 모드는 권한 확인 없이 도구를 쓴다(spec 5.2).
  return { ...base, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
}

export function toClaudeResult(msg: SDKResultMessage | undefined, model: string): AgentResult {
  if (!msg) return failedResult(model, "engine_error", "claude: no result message");
  const usage = Object.values(msg.modelUsage).reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  const base = { model, turns: msg.num_turns, costUsd: msg.total_cost_usd, usage };
  if (msg.subtype === "success") {
    return msg.is_error
      ? { ...base, ok: false, summary: msg.result, failureReason: "engine_error" }
      : { ...base, ok: true, summary: msg.result };
  }
  const reason: FailureReason =
    msg.subtype === "error_max_turns"
      ? "max_turns"
      : msg.subtype === "error_max_budget_usd"
        ? "budget"
        : "engine_error";
  return { ...base, ok: false, summary: msg.errors.join("\n"), failureReason: reason };
}

export function createClaudeAdapter(opts: {
  model: string;
  env: Record<string, string>;
  query?: QueryFn;
}): AgentAdapter {
  const query = opts.query ?? sdkQuery;
  return {
    name: "claude",
    async run(task) {
      const controller = new AbortController();
      task.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      let last: SDKResultMessage | undefined;
      try {
        const stream = query({
          prompt: task.prompt,
          options: claudeOptions(task, opts.model, opts.env, controller),
        });
        for await (const message of stream) {
          if (message.type === "result") last = message;
        }
      } catch (e) {
        const aborted = controller.signal.aborted || task.signal?.aborted === true;
        return failedResult(opts.model, aborted ? "timeout" : "engine_error", errorMessage(e));
      }
      return toClaudeResult(last, opts.model);
    },
  };
}
