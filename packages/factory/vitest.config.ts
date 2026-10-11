import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], exclude: ["test/contract/**"], testTimeout: 20_000 },
});
