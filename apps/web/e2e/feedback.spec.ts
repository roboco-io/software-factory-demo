import { expect, test } from "@playwright/test";
import { feedbackAllowed } from "../src/lib/e2eTarget";

test("anonymous feedback from the footer", async ({ page }) => {
  test.skip(
    !feedbackAllowed(process.env.E2E_BASE_URL),
    "로컬·PR 프리뷰가 아니면 피드백을 보내지 않는다(실제 이슈가 열린다)",
  );
  await page.goto("./");
  await page.getByRole("button", { name: "피드백" }).click();
  await page.getByPlaceholder("무엇이 불편했는지 알려 주세요").fill(`e2e feedback ${Date.now()}`);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText("피드백을 보냈습니다. 고맙습니다.")).toBeVisible();
});
