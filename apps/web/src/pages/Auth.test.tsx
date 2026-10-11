import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { Auth } from "./Auth";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderAt(path: "/login" | "/register") {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />
          <Route path="/" element={<div>home page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("Auth page", () => {
  it("shows server validation errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errors: { email: ["has already been taken"] } }), {
            status: 409,
          }),
      ),
    );
    renderAt("/register");
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "u" } });
    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "u@test.com" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    expect(await screen.findByText("email has already been taken")).toBeInTheDocument();
  });

  it("stores token and navigates home on login", async () => {
    const user = { email: "u@test.com", token: "jwt-1", username: "u", bio: null, image: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ user }), { status: 200 })),
    );
    renderAt("/login");
    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "u@test.com" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("home page")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(`jwt:${API_BASE}`)).toBe("jwt-1"));
  });
});
