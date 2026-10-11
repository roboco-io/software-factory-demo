import { expect, test } from "@playwright/test";

// 프로덕션에는 피드백을 보내지 않는다(실제 이슈가 열린다). 프로덕션 검사는 e2e-smoke가 읽기 전용으로 한다.
function isProductionOrigin(): boolean {
  const raw = process.env.E2E_BASE_URL;
  if (!raw) return false;
  const production = new Set(["https://roboco.io"]);
  if (process.env.WEB_URL) {
    try {
      production.add(new URL(process.env.WEB_URL).origin);
    } catch {
      // 잘못된 WEB_URL은 무시한다.
    }
  }
  try {
    return production.has(new URL(raw).origin);
  } catch {
    // 해석할 수 없는 URL은 안전하게 프로덕션으로 본다.
    return true;
  }
}

test("anonymous feedback from the footer", async ({ page }) => {
  test.skip(isProductionOrigin(), "프로덕션에는 피드백을 보내지 않는다");
  await page.goto("./");
  await page.getByRole("button", { name: "피드백" }).click();
  await page.getByPlaceholder("무엇이 불편했는지 알려 주세요").fill(`e2e feedback ${Date.now()}`);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText("피드백을 보냈습니다. 고맙습니다.")).toBeVisible();
});
