import { test, expect } from "@playwright/test";

test("keeps file controls separate while an expiry change and upload overlap", async ({
  page,
  context,
  request,
}) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": "10.240.1.9" });
  await page.setViewportSize({ width: 390, height: 844 });
  let creations = 0;
  await page.route("**/api/transfers", async (route) => {
    if (route.request().method() === "POST" && ++creations === 2) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
      });
    }
    await route.continue();
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
  ]);
  await page.getByLabel("Link expires after").selectOption("21600");
  await page.getByRole("button", { name: "Create links" }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  const first = page.getByRole("region", { name: "first.txt", exact: true });
  const second = page.getByRole("region", { name: "second.txt", exact: true });
  const firstLink = await first.getByLabel("Share link").inputValue();
  const firstId = new URL(firstLink).pathname.split("/").at(-1)!;
  await first.getByRole("button", { name: "Change expiry" }).click();
  await expect(first.getByLabel("Link expires after")).toHaveValue("21600");
  await first.getByLabel("Link expires after").selectOption("86400");

  let releaseSave!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(`**/api/transfers/${firstId}/expiry`, async (route) => {
    await gate;
    await route.continue();
  });
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/api/transfers/${firstId}/expiry`),
  );
  await first.getByRole("button", { name: "Save expiry" }).click();
  try {
    await expect(first.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(second.getByLabel("Share link")).toBeVisible();
  } finally {
    releaseSave();
  }
  expect((await saved).ok()).toBe(true);
  await expect(
    first.getByRole("button", { name: "Change expiry" }),
  ).toBeFocused();
  await expect(first.getByLabel("Share link")).toHaveValue(firstLink);
  const secondLink = await second.getByLabel("Share link").inputValue();
  const secondId = new URL(secondLink).pathname.split("/").at(-1)!;
  const firstMetadata = await (
    await request.get(`/api/transfers/${firstId}`)
  ).json();
  const secondMetadata = await (
    await request.get(`/api/transfers/${secondId}`)
  ).json();
  expect(Date.parse(firstMetadata.expiresAt) - Date.now()).toBeGreaterThan(
    86_300_000,
  );
  expect(Date.parse(secondMetadata.expiresAt) - Date.now()).toBeGreaterThan(
    21_500_000,
  );
  expect(Date.parse(secondMetadata.expiresAt) - Date.now()).toBeLessThanOrEqual(
    21_600_000,
  );

  await first.getByRole("button", { name: "Change expiry" }).click();
  await second.getByRole("button", { name: "Change expiry" }).click();
  await expect(first.getByLabel("Link expires after")).toHaveValue("86400");
  await expect(second.getByLabel("Link expires after")).toHaveValue("21600");
  expect(
    await page.evaluate(() => {
      const ids = Array.from(
        document.querySelectorAll("[id]"),
        (node) => node.id,
      );
      return ids.length === new Set(ids).size;
    }),
  ).toBe(true);
  await second.getByLabel("Link expires after").selectOption("1800");
  await second.getByRole("button", { name: "Save expiry" }).click();
  await expect(
    second.getByRole("button", { name: "Save expiry" }),
  ).toBeHidden();
  const shortened = await (
    await request.get(`/api/transfers/${secondId}`)
  ).json();
  expect(Date.parse(shortened.expiresAt) - Date.now()).toBeGreaterThan(
    1_700_000,
  );
  expect(Date.parse(shortened.expiresAt) - Date.now()).toBeLessThanOrEqual(
    1_800_000,
  );
  expect(await (await request.get(`/api/transfers/${firstId}`)).json()).toEqual(
    firstMetadata,
  );
  await first.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.setViewportSize({ width: 320, height: 740 });
  await second.getByRole("button", { name: "Delete file early" }).click();
  await expect(
    second.getByRole("button", { name: "Change expiry" }),
  ).toBeDisabled();
  await second
    .getByRole("button", { name: "Delete file", exact: true })
    .click();
  await expect(
    second.getByRole("status").filter({ hasText: "File deleted" }),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Change expiry" }),
  ).toHaveCount(0);
  await expect(
    first.getByRole("link", { name: "Send more files" }),
  ).toBeVisible();
  await expect(first.getByLabel("Share link")).toHaveValue(firstLink);
  expect((await request.get(`/api/transfers/${secondId}`)).status()).toBe(404);
  expect(await (await request.get(`/api/transfers/${firstId}`)).json()).toEqual(
    firstMetadata,
  );
});
