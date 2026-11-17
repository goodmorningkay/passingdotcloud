import { test, expect } from "@playwright/test";

test("opens a prefetched public page while its endpoint is unavailable", async ({
  page,
}) => {
  const prefetched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/help" &&
      response.request().headers()["next-router-prefetch"] === "1",
  );
  await page.goto("/");
  const help = page.getByRole("link", { name: "Help", exact: true });
  await help.scrollIntoViewIfNeeded();
  await prefetched;
  // This page has no API polling. Wait for the public page prefetches to finish.
  await page.waitForLoadState("networkidle");

  await page.route(/\/help(?:\?|$)/, async (route) => {
    await route.abort();
  });
  await help.click();
  await expect(
    page.getByRole("heading", { name: "How to send a file", exact: true }),
  ).toBeVisible();
});

test("loads an idle encryption worker on selection and reuses it for upload", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": "10.240.2.1" });
  const workers: string[] = [];
  const apiRequests: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/transfers"))
      apiRequests.push(request.method());
  });
  await page.goto("/");
  expect(workers).toHaveLength(0);

  const loaded = page.waitForEvent("worker");
  await page.locator('input[type="file"]').setInputFiles({
    name: "worker-reuse.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("The worker must wait for Create link."),
  });
  const worker = await loaded;
  expect(new URL(worker.url()).origin).toBe(new URL(page.url()).origin);
  expect(apiRequests).toEqual([]);

  let closed = false;
  worker.on("close", () => {
    closed = true;
  });
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(page.getByLabel("Share link")).toBeVisible();
  expect(workers).toHaveLength(1);
  expect(apiRequests).toEqual(["POST", "PUT"]);
  await expect.poll(() => closed).toBe(true);
});

test("releases an idle worker when selection is empty or the user leaves", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/transfers"))
      apiRequests.push(request.url());
  });
  await page.goto("/");

  const firstLoaded = page.waitForEvent("worker");
  await page.locator('input[type="file"]').setInputFiles({
    name: "remove.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Remove this selection."),
  });
  const first = await firstLoaded;
  let firstClosed = false;
  first.on("close", () => {
    firstClosed = true;
  });
  await page.getByRole("button", { name: "Remove remove.txt" }).click();
  await expect.poll(() => firstClosed).toBe(true);

  const secondLoaded = page.waitForEvent("worker");
  await page.locator('input[type="file"]').setInputFiles({
    name: "leave.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Leave this selection."),
  });
  const second = await secondLoaded;
  let secondClosed = false;
  second.on("close", () => {
    secondClosed = true;
  });
  await page.getByRole("link", { name: "Help", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "How to send a file", exact: true }),
  ).toBeVisible();
  await expect.poll(() => secondClosed).toBe(true);
  expect(apiRequests).toEqual([]);
});
