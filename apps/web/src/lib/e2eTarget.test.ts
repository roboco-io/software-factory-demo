import { describe, expect, it } from "vitest";
import { feedbackAllowed } from "./e2eTarget";

describe("feedbackAllowed", () => {
  it.each([
    [undefined, true],
    ["http://localhost:4173/", true],
    ["http://127.0.0.1:4173/", true],
    ["https://roboco.io/software-factory-demo/pr-preview/pr-12/", true],
    ["https://roboco.io/software-factory-demo/", false],
    ["http://roboco.io/software-factory-demo/", false],
    ["https://www.roboco.io/software-factory-demo/", false],
    ["https://roboco-io.github.io/software-factory-demo/", false],
    ["https://roboco.io/software-factory-demo/pr-preview/pr-x/", false],
    ["garbage", false],
  ])("%s -> %s", (url, expected) => {
    expect(feedbackAllowed(url)).toBe(expected);
  });
});
