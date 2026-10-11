import type { ThreadOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import {
  codexThreadOptions,
  createCodexAdapter,
  type CodexLike,
  type CodexTurn,
} from "../src/agents/codex";
import type { AgentTask } from "../src/agents/types";

const task = (readOnly: boolean): AgentTask => ({
  role: readOnly ? "review" : "implement",
  prompt: "review this",
  cwd: "/work",
  readOnly,
  budget: { maxTurns: 30, timeoutMs: 900_000, maxUsd: 2 },
});

function fakeCodex(turn: CodexTurn | Error, seen: ThreadOptions[] = []): CodexLike {
  return {
    startThread(options) {
      seen.push(options);
      return {
        run: async () => {
          if (turn instanceof Error) throw turn;
          return turn;
        },
      };
    },
  };
}

const turn: CodexTurn = {
  finalResponse: '{"verdict":"APPROVE"}',
  items: [{ type: "command_execution" }, { type: "agent_message" }],
  usage: { input_tokens: 500_000, output_tokens: 250_000 },
};

describe("codexThreadOptions", () => {
  it("uses the read-only sandbox for read-only tasks and never asks for approval", () => {
    expect(codexThreadOptions(task(true), "gpt-6.1-sol")).toEqual({
      model: "gpt-6.1-sol",
      workingDirectory: "/work",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
    });
    expect(codexThreadOptions(task(false), "m").sandboxMode).toBe("workspace-write");
  });
});

describe("createCodexAdapter", () => {
  it("maps the final response, item count and token usage", async () => {
    const seen: ThreadOptions[] = [];
    const a = createCodexAdapter({
      model: "gpt-6.1-sol",
      env: {},
      price: null,
      codex: fakeCodex(turn, seen),
    });
    expect(await a.run(task(true))).toEqual({
      ok: true,
      summary: '{"verdict":"APPROVE"}',
      model: "gpt-6.1-sol",
      turns: 2,
      usage: { inputTokens: 500_000, outputTokens: 250_000 },
    });
    expect(seen[0]?.sandboxMode).toBe("read-only");
  });

  it("estimates cost only when a price is configured", async () => {
    const a = createCodexAdapter({
      model: "m",
      env: {},
      price: { input: 2, output: 8 },
      codex: fakeCodex(turn),
    });
    expect((await a.run(task(true))).costUsd).toBe(3);
  });

  it("maps a thrown error to engine_error, or timeout when aborted", async () => {
    const a = createCodexAdapter({
      model: "m",
      env: {},
      price: null,
      codex: fakeCodex(new Error("sandbox denied")),
    });
    expect(await a.run(task(false))).toMatchObject({
      ok: false,
      failureReason: "engine_error",
      summary: "sandbox denied",
    });
    const controller = new AbortController();
    controller.abort();
    expect((await a.run({ ...task(false), signal: controller.signal })).failureReason).toBe(
      "timeout",
    );
  });
});
