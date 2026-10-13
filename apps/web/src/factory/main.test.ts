import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "./data";

const run = (
  values: Partial<Run> & { issue: number; role: string; model?: string | null },
): Run => ({
  ts: "2026-10-12T08:00:00Z",
  engine: null,
  ok: true,
  costUsd: null,
  failureReason: null,
  ...values,
});

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
  document.body.innerHTML = '<main id="factory"></main>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function openDashboard(
  runs: Run[],
  improvements: { pr: number; key: string; mergedAt: string }[] = [],
) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("improvements.json")) return Response.json(improvements);
    if (url.endsWith("2026-10.jsonl"))
      return new Response(runs.map((r) => JSON.stringify(r)).join("\n"));
    return new Response("", { status: 404 });
  });
  await import("./main");
}

describe("dashboard experience", () => {
  it("lets visitors follow a deployed request and select another request's approval history", async () => {
    await openDashboard([
      run({ issue: 42, role: "deploy", ts: "2026-10-12T12:00:00Z" }),
      run({ issue: 42, role: "implement", ts: "2026-10-11T08:00:00Z" }),
      run({ issue: 41, role: "implement", ts: "2026-10-11T06:00:00Z" }),
      run({
        issue: 41,
        role: "gate",
        ok: false,
        failureReason: "risk_t2",
        ts: "2026-10-11T07:00:00Z",
      }),
    ]);
    const story = await screen.findByRole("region", { name: "요청 하나의 처리 과정" });
    expect(within(story).getByRole("link", { name: "#42 요청 보기" })).toHaveAttribute(
      "href",
      "https://github.com/roboco-io/the-software-factory-demo/issues/42",
    );
    expect(within(story).getByText("배포 완료 기록")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "살펴볼 요청" }), {
      target: { value: "41" },
    });
    expect(within(story).getByRole("link", { name: "#41 요청 보기" })).toBeInTheDocument();
    expect(within(story).getByText("사람 승인 대기 기록")).toBeInTheDocument();
    expect(within(story).getByText(/현재 상태는 GitHub 요청에서 확인/)).toBeInTheDocument();
  });

  it("shows missing costs as partial coverage and separates different AI roles", async () => {
    await openDashboard([
      run({ issue: 1, role: "implement", engine: "claude", costUsd: 0 }),
      run({ issue: 1, role: "review", engine: "codex" }),
    ]);
    const cost = await screen.findByRole("group", { name: "기록된 AI 비용" });
    expect(within(cost).getByText("$0.00")).toBeInTheDocument();
    expect(within(cost).getByText(/1\/2회/)).toBeInTheDocument();
    expect(within(cost).getByText(/부분 합계/)).toBeInTheDocument();
    const roles = screen.getByRole("table", { name: "역할별 AI 실행 결과" });
    expect(within(roles).getByText("구현")).toBeInTheDocument();
    expect(within(roles).getByText("검토")).toBeInTheDocument();
    expect(within(roles).getByText("미보고")).toBeInTheDocument();
    expect(screen.queryByText("무개입 완주율")).not.toBeInTheDocument();
  });

  it("shows actual tool and model combinations separately, including models in the request history", async () => {
    await openDashboard([
      run({ issue: 1, role: "implement", engine: "claude", model: "model-a", costUsd: 0.5 }),
      run({ issue: 2, role: "implement", engine: "claude", model: "model-b" }),
      run({ issue: 3, role: "review", engine: "codex" }),
    ]);
    const roles = await screen.findByRole("table", { name: "역할별 AI 실행 결과" });
    expect(within(roles).getByText("model-a")).toBeInTheDocument();
    expect(within(roles).getByText("model-b")).toBeInTheDocument();
    expect(within(roles).getByText("모델 미기록")).toBeInTheDocument();
    expect(within(roles).getAllByRole("row")).toHaveLength(4);
    fireEvent.change(screen.getByRole("combobox", { name: "살펴볼 요청" }), {
      target: { value: "3" },
    });
    expect(
      within(screen.getByRole("region", { name: "요청 하나의 처리 과정" })).getByText(
        /codex · 모델 미기록/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "살펴볼 요청" }), {
      target: { value: "2" },
    });
    expect(
      within(screen.getByRole("region", { name: "요청 하나의 처리 과정" })).getByText(
        /claude · model-b/,
      ),
    ).toBeInTheDocument();
  });

  it("shows an improvement's evidence without calling no after-observations an improvement", async () => {
    await openDashboard(
      [
        run({
          issue: 41,
          role: "review",
          ts: "2026-10-12T07:00:00Z",
          findings: [{ category: "error-format" }, { category: "error-format" }],
        }),
      ],
      [{ pr: 47, key: "review:error-format", mergedAt: "2026-10-12T08:00:00Z" }],
    );
    const evidence = await screen.findByRole("region", { name: "실패가 규칙으로 바뀌는 과정" });
    expect(within(evidence).getByRole("link", { name: "개선 PR #47" })).toHaveAttribute(
      "href",
      "https://github.com/roboco-io/the-software-factory-demo/pull/47",
    );
    expect(within(evidence).getByText("표본 부족 · 효과 판단 보류")).toBeInTheDocument();
    expect(within(evidence).getByText(/관찰 대상 0개 요청/)).toBeInTheDocument();
    expect(within(evidence).getByRole("link", { name: "규칙 검증 결과 보기" })).toHaveAttribute(
      "href",
      "https://github.com/roboco-io/the-software-factory-demo/pull/47/checks",
    );
  });

  it("gives a next step without fabricating a timeline or free AI usage when there are no records", async () => {
    await openDashboard([]);
    expect(await screen.findByText("아직 처리 과정이 기록되지 않았습니다.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "기능 요청 작성" })).toHaveAttribute(
      "href",
      "https://github.com/roboco-io/the-software-factory-demo/issues/new?template=feature.yml",
    );
    expect(
      within(screen.getByRole("group", { name: "기록된 AI 비용" })).getByText("미보고"),
    ).toBeInTheDocument();
  });

  it("keeps old improvement links without describing unloaded months as zero failures", async () => {
    await openDashboard(
      [],
      [{ pr: 10, key: "review:error-format", mergedAt: "2026-06-01T00:00:00Z" }],
    );
    const evidence = await screen.findByRole("region", { name: "실패가 규칙으로 바뀌는 과정" });
    await waitFor(() => expect(within(evidence).getAllByText("관찰 데이터 없음")).toHaveLength(2));
    expect(within(evidence).queryByText("0건의 관련 지적·실패")).not.toBeInTheDocument();
    expect(within(evidence).getByRole("link", { name: "개선 PR #10" })).toHaveAttribute(
      "href",
      "https://github.com/roboco-io/the-software-factory-demo/pull/10",
    );
  });

  it("shows unmeasurable improvement categories as unavailable instead of no failures", async () => {
    await openDashboard([], [{ pr: 11, key: "revert", mergedAt: "2026-10-12T08:00:00Z" }]);
    const evidence = await screen.findByRole("region", { name: "실패가 규칙으로 바뀌는 과정" });
    expect(
      within(evidence).getByText(/이 범주는 실행 기록만으로 집계할 수 없습니다/),
    ).toBeInTheDocument();
    expect(within(evidence).queryByText("0건의 관련 지적·실패")).not.toBeInTheDocument();
  });

  it("still shows valid evidence when an older run contains malformed review findings", async () => {
    await openDashboard([
      run({ issue: 1, role: "review", findings: null as unknown as Run["findings"] }),
      run({
        issue: 2,
        role: "review",
        findings: [null, { category: "error-format" }] as unknown as Run["findings"],
      }),
    ]);
    expect(await screen.findByRole("table", { name: "주별 지적과 실패 건수" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("recovers after a failed data load when the visitor retries", async () => {
    let failing = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (failing) return new Response("", { status: 503 });
      return String(input).endsWith("improvements.json")
        ? Response.json([])
        : new Response("", { status: 404 });
    });
    await import("./main");
    expect(await screen.findByRole("alert")).toHaveTextContent("기록을 불러오지 못했습니다");
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByText("아직 처리 과정이 기록되지 않았습니다.")).toBeInTheDocument();
  });
});
