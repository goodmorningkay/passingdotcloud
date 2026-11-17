import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";

test.beforeEach(async ({ context }, testInfo) => {
  const address = createHash("sha256").update(testInfo.testId).digest();
  await context.setExtraHTTPHeaders({
    "x-forwarded-for": `10.${address[0]}.${address[1]}.${address[2]}`,
  });
});

test("the owner can review reports and delete files without file keys", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "private-admin-test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Private test contents."),
  });
  await page.getByRole("button", { name: "Create link" }).click();
  const linkField = page.getByLabel("Share link");
  await expect(linkField).toBeVisible();
  const link = new URL(await linkField.inputValue());
  const id = link.pathname.split("/").at(-1)!;
  const comment =
    "Please review <img src=x onerror=alert(1)> in this test report.";
  await page.goto(`/report?id=${id}`);
  await page.getByLabel("Reason").fill(comment);
  await page.getByRole("button", { name: "Report and block file" }).click();
  await expect(
    page.getByRole("heading", { name: "Report received" }),
  ).toBeVisible();

  const adminRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin"))
      adminRequests.push(request.url(), request.postData() ?? "");
  });
  const response = await page.goto("/admin");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  expect(response?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.getByLabel("Admin key", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByLabel("Admin key", { exact: true }).fill("b".repeat(64));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Sign in with the admin key.",
  );
  await page.getByLabel("Admin key", { exact: true }).fill("a".repeat(64));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByLabel("Search by file ID", { exact: true }).fill(id);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: `Details for ${id}` }).click();
  const dialog = page.getByRole("dialog", { name: "File details" });
  await expect(dialog.getByText(comment, { exact: true })).toBeVisible();
  await expect(dialog.locator("img")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Restore access", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Restore access", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "The report is closed." }),
  ).toBeVisible();
  await expect(page.getByText("No files match this view.")).toBeVisible();

  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(
    page.getByRole("button", { name: `Details for ${id}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Details for ${id}` }).click();
  await dialog
    .getByRole("button", { name: "Delete file", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Delete file", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Delete file", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "The file was deleted." }),
  ).toBeVisible();
  await expect(page.getByText("No files match this view.")).toBeVisible();

  expect(adminRequests.join("\n")).not.toContain(link.hash.slice(1));
  expect(adminRequests.join("\n")).not.toContain("private-admin-test.txt");
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  expect(
    (await context.cookies()).some(
      (cookie) =>
        cookie.name === "passing_admin" &&
        cookie.httpOnly &&
        cookie.sameSite === "Strict",
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  expect(errors).toEqual([]);
});

test("shows request failures without exposing cached file data", async ({
  page,
}) => {
  await page.route("**/api/admin/session", (route) => route.abort());
  await page.goto("/admin");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "The request did not complete. Try again.",
  );
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/admin/session");
  await page.route("**/api/admin/login", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
    }),
  );
  await page.getByLabel("Admin key", { exact: true }).fill("a".repeat(64));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "The request did not complete. Try again.",
  );
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.unroute("**/api/admin/login");
  await page.getByLabel("Admin key", { exact: true }).fill("a".repeat(64));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  await page.route("**/api/admin/files?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "The request failed. Refresh the list and try again.",
  );
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.unroute("**/api/admin/files?*");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});
