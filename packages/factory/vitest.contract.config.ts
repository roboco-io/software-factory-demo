import { defineConfig } from "vitest/config";

// 실제 엔진을 호출하는 계약 테스트. FACTORY_CONTRACT=1일 때만 실행된다(spec 8장, 수동·주 1회).
export default defineConfig({
  test: { include: ["test/contract/**/*.contract.test.ts"], testTimeout: 600_000 },
});
