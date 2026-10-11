import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorList } from "./ErrorList";

describe("ErrorList", () => {
  it("renders each message", () => {
    render(
      <ErrorList errors={{ email: ["has already been taken"], password: ["can't be blank"] }} />,
    );
    expect(screen.getByText("email has already been taken")).toBeInTheDocument();
    expect(screen.getByText("password can't be blank")).toBeInTheDocument();
  });
  it("renders nothing when empty", () => {
    const { container } = render(<ErrorList errors={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
