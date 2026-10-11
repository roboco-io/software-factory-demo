import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/main";

describe("buildDeps agent phase", () => {
  it.each(["GITHUB_TOKEN", "GH_TOKEN", "FACTORY_TOKEN", "ACTIONS_RUNTIME_TOKEN"])(
    "throws when %s is present",
    (key) => {
      expect(() => buildDeps({ [key]: "x" }, "agent")).toThrow(key);
    },
  );

  it("builds without GitHub access when no token is present", () => {
    const deps = buildDeps({}, "agent");
    expect(deps.settings.token).toBeNull();
  });
});
