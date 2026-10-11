import { describe, expect, it } from "vitest";
import { sha256Bytes, sha256Hex } from "../src/lib/hash";

describe("sha256Hex", () => {
  it("returns the lowercase hex digest", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("sha256Bytes", () => {
  it("returns the 32 raw digest bytes", async () => {
    const bytes = await sha256Bytes("abc");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    expect(bytes[0]).toBe(0xba);
    expect(bytes[31]).toBe(0xad);
  });
});
