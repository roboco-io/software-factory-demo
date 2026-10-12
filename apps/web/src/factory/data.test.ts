import { describe, expect, it } from "vitest";
import { loadImprovements, loadRuns, parseRuns, recentMonths } from "./data";

const line =
  '{"ts":"2026-10-01T00:00:00Z","issue":1,"role":"implement","engine":"claude","ok":true,"costUsd":0.5,"failureReason":null}';

describe("data", () => {
  it("skips months that do not exist yet and parses the rest", async () => {
    const f = (async (url: string) =>
      url.endsWith("2026-10.jsonl")
        ? new Response(`${line}\nnot json\n`)
        : new Response("", { status: 404 })) as unknown as typeof fetch;
    const runs = await loadRuns(new Date("2026-10-12T00:00:00Z"), f);
    expect(runs).toHaveLength(1);
  });
  it("throws on a server error instead of showing an empty dashboard", async () => {
    const f = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(loadRuns(new Date("2026-10-12T00:00:00Z"), f)).rejects.toThrow();
  });
  it("drops lines missing required fields", () => {
    expect(parseRuns(`${line}\n{"ts":"x"}\n\n`)).toHaveLength(1);
  });
  it("keeps explicit model names and normalizes unrecorded or malformed models to null", () => {
    const original = JSON.parse(line);
    const rows = [
      { ...original, model: "gpt-6.1-sol" },
      original,
      { ...original, model: "   " },
      { ...original, model: 123 },
    ];
    expect(parseRuns(rows.map((r) => JSON.stringify(r)).join("\n")).map((r) => r.model)).toEqual([
      "gpt-6.1-sol",
      null,
      null,
      null,
    ]);
  });
  it("lists recent months oldest first across a year boundary", () => {
    expect(recentMonths(new Date("2026-10-12T00:00:00Z"), 3)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(recentMonths(new Date("2026-01-05T00:00:00Z"), 2)).toEqual(["2025-12", "2026-01"]);
  });
  it("returns [] for improvements on 404 and throws on 500", async () => {
    const nf = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await loadImprovements(nf)).toEqual([]);
    const err = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(loadImprovements(err)).rejects.toThrow();
  });
});
