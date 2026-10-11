import { expect, test } from "@playwright/test";

test("anonymous feedback from the footer", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "피드백" }).click();
  await page.getByPlaceholder("무엇이 불편했는지 알려 주세요").fill(`e2e feedback ${Date.now()}`);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText("피드백을 보냈습니다. 고맙습니다.")).toBeVisible();
});
