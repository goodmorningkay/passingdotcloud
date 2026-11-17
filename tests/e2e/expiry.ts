import {
  expect,
  type Page,
  type BrowserContext,
  type APIRequestContext,
} from "@playwright/test";

export async function checkExpiryEditing(
  page: Page,
  context: BrowserContext,
  request: APIRequestContext,
  shareUrl: string,
) {
  await page.setViewportSize({ width: 320, height: 740 });
  const shareField = page.getByLabel("Share link");
  const link = new URL(shareUrl);
  const id = link.pathname.split("/").at(-1)!;
  const original = await (await request.get(`/api/transfers/${id}`)).json();
  const expiryText = page.locator(".expiry-note strong");
  const originalText = await expiryText.textContent();
  const receiver = await context.newPage();
  await receiver.goto(shareUrl);
  await expect(
    receiver.getByRole("button", { name: "Download file" }),
  ).toBeVisible();
  await expect(
    receiver.getByRole("button", { name: "Change expiry" }),
  ).toHaveCount(0);

  const changes: string[] = [];
  let fail = true;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/transfers/*/expiry", async (route) => {
    changes.push(route.request().url(), route.request().postData() ?? "");
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "private server detail" },
        }),
      });
    } else {
      await saveGate;
      await route.continue();
    }
  });

  const pencil = page.getByRole("button", { name: "Change expiry" });
  const duration = page.getByLabel("Link expires after");
  await expect(page.getByRole("button", { name: "Save expiry" })).toBeHidden();
  await pencil.focus();
  await page.keyboard.press("Enter");
  await expect(duration).toBeFocused();
  await expect(duration.locator("option")).toHaveCount(6);
  await expect(duration).toHaveValue("3600");
  await duration.selectOption("86400");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(pencil).toBeFocused();
  await expect(expiryText).toHaveText(originalText!);
  await pencil.click();
  await expect(duration).toHaveValue("3600");
  await expect(duration).toBeFocused();
  await duration.press("Escape");
  await expect(pencil).toBeFocused();
  expect(changes).toEqual([]);

  await pencil.click();
  await duration.selectOption("86400");
  await page.getByRole("button", { name: "Save expiry" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "The service is busy",
  );
  await expect(page.getByRole("main").getByRole("alert")).not.toContainText(
    "private server detail",
  );
  await expect(expiryText).toHaveText(originalText!);
  await expect(duration).toHaveValue("86400");

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/transfers/${id}/expiry`) &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Save expiry" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete file early" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(duration).toBeDisabled();
  await expect(pencil).toBeDisabled();
  releaseSave();
  const updated = await (await saved).json();
  expect(Date.parse(updated.expiresAt) - Date.now()).toBeGreaterThan(
    86_300_000,
  );
  expect(Date.parse(updated.expiresAt) - Date.now()).toBeLessThanOrEqual(
    86_400_000,
  );
  await expect(expiryText).not.toHaveText(originalText!);
  await expect(pencil).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "Expiry changed." }),
  ).toBeVisible();
  await expect(shareField).toHaveValue(shareUrl);

  // The receiver must recheck metadata when its old expiry passes.
  await receiver.clock.setFixedTime(
    new Date(Date.parse(original.expiresAt) + 1000),
  );
  await expect(receiver.locator(".receive-expiry strong")).toHaveText(
    (await expiryText.textContent())!,
  );
  await expect(
    receiver.getByRole("button", { name: "Download file" }),
  ).toBeVisible();
  await receiver.clock.setFixedTime(new Date());

  await pencil.click();
  await expect(duration).toHaveValue("86400");
  await duration.selectOption("1800");
  const shortened = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/transfers/${id}/expiry`) &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Save expiry" }).click();
  const shorter = await (await shortened).json();
  expect(Date.parse(shorter.expiresAt)).toBeLessThan(
    Date.parse(original.expiresAt),
  );
  expect(Date.parse(shorter.expiresAt) - Date.now()).toBeGreaterThan(1_700_000);
  await expect(page.getByRole("button", { name: "Save expiry" })).toBeHidden();
  await receiver.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(receiver.locator(".receive-expiry strong")).toHaveText(
    (await expiryText.textContent())!,
  );
  expect(changes.join("\n")).not.toContain(link.hash.slice(1));
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  await receiver.close();
  await page.unroute("**/api/transfers/*/expiry");
  await page.setViewportSize({ width: 1280, height: 900 });
}
