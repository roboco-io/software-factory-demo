import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders markdown", () => {
    expect(renderMarkdown("# Title\n\n**bold**")).toContain("<strong>bold</strong>");
  });
  it("strips script tags and event handlers", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src="x" onerror="alert(1)">ok');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("ok");
  });
  it("strips javascript: links", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
  });
});
