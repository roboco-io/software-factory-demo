import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { Footer, feedbackPath } from "./Footer";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Call = [RequestInfo | URL, RequestInit | undefined];

function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (String(input).endsWith("/user")) {
        const user = { email: "u@test.com", token: "jwt-1", username: "u", bio: null, image: null };
        return new Response(JSON.stringify({ user }), { status: 200 });
      }
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Footer />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const openModal = () => fireEvent.click(screen.getByRole("button", { name: "피드백" }));
const typeText = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText("무엇이 불편했는지 알려 주세요"), {
    target: { value: v },
  });

describe("Footer feedback", () => {
  it("sends anonymous feedback with the current hash path, without the login token", async () => {
    localStorage.setItem(`jwt:${API_BASE}`, "jwt-1");
    const calls = stubFetch(201, { feedback: { received: true } });
    renderAt("/article/abc");
    openModal();
    typeText("  좋아요  ");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByText("피드백을 보냈습니다. 고맙습니다.")).toBeInTheDocument();
    const [url, init] = calls.find(([u]) => String(u).endsWith("/feedback"))!;
    expect(String(url)).toBe(`${API_BASE}/feedback`);
    expect(JSON.parse(String(init?.body))).toEqual({
      feedback: { body: "좋아요", path: "/#/article/abc" },
    });
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("shows the server error when rate-limited", async () => {
    stubFetch(429, { errors: { feedback: ["too many requests"] } });
    renderAt("/");
    openModal();
    typeText("again");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByText("feedback too many requests")).toBeInTheDocument();
  });

  it("keeps 보내기 disabled for blank or over-long text and closes with 닫기", () => {
    stubFetch(201, {});
    renderAt("/");
    openModal();
    const send = screen.getByRole("button", { name: "보내기" });
    expect(send).toBeDisabled();
    typeText("   ");
    expect(send).toBeDisabled();
    typeText("x".repeat(2001));
    expect(send).toBeDisabled();
    typeText("ok");
    expect(send).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is an accessible dialog: focuses the textarea and closes on Escape", () => {
    stubFetch(201, {});
    renderAt("/");
    openModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByPlaceholderText("무엇이 불편했는지 알려 주세요")).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("caps the reported path at 200 characters", () => {
    expect(feedbackPath("/editor")).toBe("/#/editor");
    expect(feedbackPath(`/${"a".repeat(300)}`)).toHaveLength(200);
  });
});
