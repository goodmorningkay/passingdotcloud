import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_BYTES, TTL_OPTIONS } from "../../lib/shared/constants";
import { listReports, reviewReport } from "../../server/review";
import { checkExpiryEditing } from "./expiry";

let fixtures: string | undefined;
let maxFile: string;
let secondMaxFile: string;
let oversizedFile: string;

async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function send(page: Page, name: string, content: Buffer) {
  await page.goto("/");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "text/plain", buffer: content });
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByLabel("Share link")).toBeVisible();
  return page.getByLabel("Share link").inputValue();
}

test.beforeAll(async () => {
  const testRoot = path.resolve(".test-data");
  await mkdir(testRoot, { recursive: true });
  fixtures = await mkdtemp(path.join(testRoot, "e2e-fixtures-"));
  maxFile = path.join(fixtures, "100mb-boundary.bin");
  secondMaxFile = path.join(fixtures, "second-100mb-boundary.bin");
  oversizedFile = path.join(fixtures, "over-100mb.bin");
  for (const [file, size] of [
    [maxFile, MAX_FILE_BYTES],
    [secondMaxFile, MAX_FILE_BYTES],
    [oversizedFile, MAX_FILE_BYTES + 1],
  ] as const) {
    const handle = await open(file, "w");
    try {
      await handle.truncate(size);
      await handle.write(Buffer.from("passing.cloud boundary test"), 0, 27, 0);
      await handle.write(
        Buffer.from(file === secondMaxFile ? "two" : "end"),
        0,
        3,
        size - 3,
      );
    } finally {
      await handle.close();
    }
  }
});

test.afterAll(async () => {
  if (fixtures) {
    await rm(fixtures, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test.beforeEach(async ({ context }, testInfo) => {
  const address = createHash("sha256").update(testInfo.testId).digest();
  await context.setExtraHTTPHeaders({
    "x-forwarded-for": `10.${address[0]}.${address[1]}.${address[2]}`,
  });
});

test("encrypts a file, changes expiry, protects request data, downloads it, and deletes it", async ({
  page,
  context,
  request,
}) => {
  const content = Buffer.from(
    "Private test contents: passing.cloud complete browser flow.",
  );
  const name = "private-browser-test.txt";
  const apiRequests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) {
      apiRequests.push(r.url(), JSON.stringify(r.headers()));
      if (r.headers()["content-type"]?.includes("application/json"))
        apiRequests.push(r.postData() ?? "");
    }
  });
  await page.goto("/");
  const duration = page.getByLabel("Link expires after");
  expect(
    await duration
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(TTL_OPTIONS.map((option) => String(option.seconds)));
  await expect(duration).toHaveValue("3600");
  await expect(
    page.getByRole("button", { name: "Create link" }),
  ).toBeDisabled();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "text/plain", buffer: content });
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByLabel("Share link")).toBeVisible();
  const shareUrl = await page.getByLabel("Share link").inputValue();
  const link = new URL(shareUrl);
  const id = link.pathname.split("/").at(-1)!;
  const key = link.hash.slice(1);
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const observed = apiRequests.join("\n");
  expect(observed).not.toContain(key);
  expect(observed).not.toContain(name);
  expect(observed).not.toContain(content.toString());
  const metadataResponse = await request.get(`/api/transfers/${id}`);
  const metadata = await metadataResponse.json();
  expect(Date.parse(metadata.expiresAt) - Date.now()).toBeGreaterThan(
    3_500_000,
  );
  expect(Date.parse(metadata.expiresAt) - Date.now()).toBeLessThanOrEqual(
    3_600_000,
  );
  expect(Object.keys(metadata).sort()).toEqual([
    "encryptedSize",
    "expiresAt",
    "id",
    "size",
  ]);
  await checkExpiryEditing(page, context, request, shareUrl);
  const cipherResponse = await request.get(`/api/transfers/${id}/content`);
  const cipher = await cipherResponse.body();
  expect(cipher.subarray(0, 8).toString()).toBe("PASSCLD1");
  expect(cipher.includes(content)).toBe(false);
  expect(cipher.includes(Buffer.from(name))).toBe(false);

  const receiver = await context.newPage();
  let automaticDownloads = 0;
  receiver.on("request", (r) => {
    if (r.url().endsWith("/content")) automaticDownloads++;
  });
  const response = await receiver.goto(shareUrl);
  expect(response?.headers()["content-security-policy"]).toContain("'nonce-");
  expect(response?.headers()["content-security-policy"]).not.toContain(
    "'unsafe-eval'",
  );
  await expect(
    receiver.getByRole("button", { name: "Download file" }),
  ).toBeVisible();
  expect(automaticDownloads).toBe(0);
  const downloaded = receiver.waitForEvent("download");
  await receiver.getByRole("button", { name: "Download file" }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe(name);
  expect(await readFile((await file.path())!)).toEqual(content);
  const sendOwnFile = receiver.getByRole("link", {
    name: "Send your own file",
  });
  await expect(sendOwnFile).toBeVisible();
  await sendOwnFile.click();
  await expect(receiver).toHaveURL("/");
  await expect(
    receiver.getByRole("button", { name: "Create link" }),
  ).toBeDisabled();
  await receiver.goBack();
  await expect(
    receiver.getByRole("button", { name: "Download file" }),
  ).toBeVisible();
  // One ciphertext inspection and one browser download have used two attempts.
  for (let attempt = 2; attempt < 10; attempt++) {
    expect((await request.get(`/api/transfers/${id}/content`)).status()).toBe(
      200,
    );
  }
  await receiver.getByRole("button", { name: "Download file" }).click();
  await expect(
    receiver.getByRole("heading", { name: "Download limit reached" }),
  ).toBeVisible();
  await expect(receiver.getByRole("main").getByRole("alert")).toContainText(
    "Ask the sender for a new link",
  );
  await expect(receiver.getByRole("button", { name: /download/i })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Delete file early" }).click();
  await page.getByRole("button", { name: "Delete file", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "File deleted" }),
  ).toBeVisible();
  expect((await request.get(`/api/transfers/${id}`)).status()).toBe(404);
  expect((await request.get(`/api/transfers/${id}/content`)).status()).toBe(
    404,
  );
  expect(errors).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  await receiver.close();
});

test("rejects a file one byte above the limit before any API request", async ({
  page,
}) => {
  let apiRequests = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) apiRequests++;
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(oversizedFile);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "100 MB or less",
  );
  await expect(
    page.getByRole("button", { name: "Create link" }),
  ).toBeDisabled();
  expect(apiRequests).toBe(0);
});

test("rejects missing keys before requesting transfer metadata", async ({
  page,
}) => {
  let apiRequests = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) apiRequests++;
  });
  await page.goto(`/t/${"a".repeat(32)}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "encryption key is missing",
  );
  expect(apiRequests).toBe(0);
});

test("rejects a wrong key without producing a download", async ({
  page,
  context,
  request,
}) => {
  const shareUrl = await send(
    page,
    "wrong-key-test.txt",
    Buffer.from("Authenticated data"),
  );
  const link = new URL(shareUrl);
  link.hash = Buffer.alloc(32, 7).toString("base64url");
  const receiver = await context.newPage();
  let downloads = 0;
  receiver.on("download", () => downloads++);
  await receiver.goto(link.href);
  await receiver.getByRole("button", { name: "Download file" }).click();
  await expect(receiver.getByRole("main").getByRole("alert")).toContainText(
    "key may be wrong",
  );
  expect(downloads).toBe(0);
  const id = link.pathname.split("/").at(-1)!;
  const reportRequests: string[] = [];
  receiver.on("request", (r) => {
    reportRequests.push(r.url());
    if (r.url().endsWith("/report")) reportRequests.push(r.postData() ?? "");
  });
  await receiver.getByRole("link", { name: "Report this file" }).click();
  await expect(receiver.getByLabel("File ID")).toHaveValue(id);
  await receiver
    .getByLabel("Reason")
    .fill("The file contains a suspicious program. Please review it.");
  await receiver.setViewportSize({ width: 390, height: 844 });
  await receiver.getByRole("button", { name: "Report and block file" }).click();
  await expect(
    receiver.getByRole("heading", { name: "Report received" }),
  ).toBeVisible();
  expect(reportRequests.join("\n")).not.toContain(link.hash.slice(1));
  expect(reportRequests.join("\n")).not.toContain(
    new URL(shareUrl).hash.slice(1),
  );
  expect((await request.get(`/api/transfers/${id}`)).status()).toBe(404);
  expect((await request.get(`/api/transfers/${id}/content`)).status()).toBe(
    404,
  );
  const directory = process.env.PASSING_E2E_DATA_DIR!;
  const report = (await listReports(directory)).find((row) => row.id === id)!;
  expect(report.comment).toBe(
    "The file contains a suspicious program. Please review it.",
  );
  await reviewReport(directory, id, report.reportId, "approve");
  await receiver.goto(shareUrl);
  const restored = receiver.waitForEvent("download");
  await receiver.getByRole("button", { name: "Download file" }).click();
  expect(await readFile((await (await restored).path())!)).toEqual(
    Buffer.from("Authenticated data"),
  );
  await receiver.close();
});

test("shows report limits and rejects keys in report comments before sending", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/transfers/*/report", async (route) => {
    requests++;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: { "Retry-After": "3600" },
      body: JSON.stringify({
        error: { code: "RATE_LIMITED", message: "Untrusted text" },
      }),
    });
  });
  await page.goto(`/report?id=${"a".repeat(32)}`);
  await page
    .getByLabel("Reason")
    .fill(`Do not send this key: ${"A".repeat(43)}`);
  await page.getByRole("button", { name: "Report and block file" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Remove share links and encryption keys",
  );
  expect(requests).toBe(0);
  await page
    .getByLabel("Reason")
    .fill("This is a report of a suspicious file.");
  await page.getByRole("button", { name: "Report and block file" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Wait 3600 seconds",
  );
  await expect(
    page.getByRole("heading", { name: "Report received" }),
  ).toHaveCount(0);
  expect(requests).toBe(1);
});

test("transfers an empty file", async ({ page, context }) => {
  const shareUrl = await send(page, "empty.txt", Buffer.alloc(0));
  const receiver = await context.newPage();
  await receiver.goto(shareUrl);
  const downloadEvent = receiver.waitForEvent("download");
  await receiver.getByRole("button", { name: "Download file" }).click();
  const downloaded = await downloadEvent;
  expect((await readFile((await downloaded.path())!)).length).toBe(0);
  await receiver.close();
});

test("transfers two 100 MB files with independent links and deletion", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page
    .locator('input[type="file"]')
    .setInputFiles([maxFile, secondMaxFile]);
  await page.getByRole("button", { name: "Create links" }).click();
  await expect(page.getByRole("heading", { name: "Links ready" })).toBeVisible({
    timeout: 120_000,
  });
  const links = await page
    .getByLabel("Share link")
    .evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value),
    );
  expect(links).toHaveLength(2);
  expect(new Set(links.map((link) => new URL(link).pathname)).size).toBe(2);
  expect(new Set(links.map((link) => new URL(link).hash)).size).toBe(2);
  const receiver = await context.newPage();
  for (const [index, file] of [maxFile, secondMaxFile].entries()) {
    const link = new URL(links[index]!);
    const metadata = await request.get(
      `/api/transfers/${link.pathname.split("/").at(-1)}`,
    );
    expect((await metadata.json()).size).toBe(MAX_FILE_BYTES);
    await receiver.goto(link.href);
    const downloadEvent = receiver.waitForEvent("download", {
      timeout: 90_000,
    });
    await receiver.getByRole("button", { name: "Download file" }).click();
    const downloaded = await downloadEvent;
    expect(downloaded.suggestedFilename()).toBe(path.basename(file));
    expect(await hashFile((await downloaded.path())!)).toBe(
      await hashFile(file),
    );
  }
  const first = page.getByRole("region", {
    name: path.basename(maxFile),
    exact: true,
  });
  const second = page.getByRole("region", {
    name: path.basename(secondMaxFile),
    exact: true,
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await second.getByRole("button", { name: "Copy link" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    links[1],
  );
  await first.getByRole("button", { name: "Delete file early" }).click();
  await first.getByRole("button", { name: "Delete file", exact: true }).click();
  await expect(
    first.getByRole("status").filter({ hasText: "File deleted" }),
  ).toBeVisible();
  await expect(second.getByLabel("Share link")).toHaveValue(links[1]!);
  const firstId = new URL(links[0]!).pathname.split("/").at(-1);
  const secondId = new URL(links[1]!).pathname.split("/").at(-1);
  expect((await request.get(`/api/transfers/${firstId}`)).status()).toBe(404);
  expect((await request.get(`/api/transfers/${secondId}`)).status()).toBe(200);
  await receiver.close();
});

test("cancels an upload and deletes its pending server session", async ({
  page,
  request,
}) => {
  let releaseUpload!: () => void;
  let uploadStarted!: (id: string) => void;
  const gate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const started = new Promise<string>((resolve) => {
    uploadStarted = resolve;
  });
  await page.route("**/api/transfers/*/content", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    uploadStarted(new URL(route.request().url()).pathname.split("/")[3]!);
    await gate;
    await route.abort("aborted").catch(() => {});
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "cancel-test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Cancel this transfer"),
  });
  await page.getByRole("button", { name: "Create link" }).click();
  const id = await started;
  const deletion = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().endsWith(`/api/transfers/${id}`),
  );
  try {
    await page.getByRole("button", { name: "Cancel upload" }).click();
  } finally {
    releaseUpload();
  }
  expect((await deletion).status()).toBe(204);
  await expect(
    page.getByRole("status").filter({ hasText: "Upload cancelled." }),
  ).toBeVisible();
  expect((await request.get(`/api/transfers/${id}/content`)).status()).toBe(
    404,
  );
  await expect(page.getByLabel("Share link")).toHaveCount(0);
});

test("adds, drops, and removes files without clearing a valid selection", async ({
  page,
}) => {
  let apiRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests++;
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  const dropzone = page.getByRole("button", { name: /Drop your files here/ });
  await dropzone.focus();
  await expect(dropzone).toBeFocused();
  const picker = page.locator('input[type="file"]');
  const selected = page.getByRole("list", { name: "Selected files" });
  await picker.setInputFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    {
      name: "second.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("second"),
    },
  ]);
  await expect(selected.getByRole("listitem")).toHaveCount(2);
  await picker.setInputFiles([maxFile, oversizedFile]);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "over-100mb.bin",
  );
  await expect(selected.getByRole("listitem")).toHaveCount(2);
  await expect(selected).toContainText("first.txt");
  await expect(selected).toContainText("second.txt");

  const dropped = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["one"], "same-name.txt", { type: "text/plain" }));
    data.items.add(
      new File(["different contents"], "same-name.txt", { type: "text/plain" }),
    );
    return data;
  });
  await page
    .getByRole("button", { name: /Add more files/ })
    .dispatchEvent("drop", { dataTransfer: dropped });
  await dropped.dispose();
  await expect(selected.getByRole("listitem")).toHaveCount(4);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Remove same-name.txt" })
    .first()
    .click();
  await page.getByRole("button", { name: "Remove second.txt" }).click();
  await expect(selected.getByRole("listitem")).toHaveCount(2);
  await expect(selected).toContainText("18 bytes");
  await expect(
    page.getByRole("button", { name: "Create links" }),
  ).toBeEnabled();
  expect(apiRequests).toBe(0);
});

test("keeps completed links after a rate limit and retries only remaining files", async ({
  page,
  context,
}) => {
  let creations = 0;
  await page.route("**/api/transfers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creations++;
    if (creations === 2) {
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Retry-After": "2" },
        body: JSON.stringify({
          error: { code: "RATE_LIMITED", message: "Untrusted text" },
        }),
      });
    }
    return route.continue();
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    {
      name: "second.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("second"),
    },
    { name: "third.txt", mimeType: "text/plain", buffer: Buffer.from("third") },
  ]);
  await page.getByRole("button", { name: "Create links" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "second.txt: Too many requests. Wait 2 seconds",
  );
  await expect(page.getByRole("main").getByRole("alert")).not.toContainText(
    "Untrusted text",
  );
  expect(creations).toBe(2);
  const firstLink = await page
    .getByRole("region", { name: "first.txt", exact: true })
    .getByLabel("Share link")
    .inputValue();
  await expect(
    page.getByRole("list", { name: "Selected files" }).getByRole("listitem"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Links ready" }),
  ).toBeVisible();
  expect(creations).toBe(4);
  await expect(page.getByLabel("Share link")).toHaveCount(3);
  await expect(
    page
      .getByRole("region", { name: "first.txt", exact: true })
      .getByLabel("Share link"),
  ).toHaveValue(firstLink);
  const receiver = await context.newPage();
  for (const name of ["first", "second", "third"]) {
    const link = await page
      .getByRole("region", { name: `${name}.txt`, exact: true })
      .getByLabel("Share link")
      .inputValue();
    await receiver.goto(link);
    const download = receiver.waitForEvent("download");
    await receiver.getByRole("button", { name: "Download file" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`${name}.txt`);
    expect(await readFile((await file.path())!)).toEqual(Buffer.from(name));
  }
  await receiver.close();
});

test("cancels a later file, retains completed links, and resumes the queue", async ({
  page,
  request,
}) => {
  let creations = 0;
  let puts = 0;
  let releaseUpload!: () => void;
  let uploadStarted!: (id: string) => void;
  const gate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const started = new Promise<string>((resolve) => {
    uploadStarted = resolve;
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/transfers"))
      creations++;
  });
  await page.route("**/api/transfers/*/content", async (route) => {
    if (route.request().method() !== "PUT" || ++puts !== 2)
      return route.continue();
    uploadStarted(new URL(route.request().url()).pathname.split("/")[3]!);
    await gate;
    await route.abort("aborted").catch(() => {});
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "complete.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("complete"),
    },
    {
      name: "cancel.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("cancel"),
    },
    {
      name: "waiting.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("waiting"),
    },
  ]);
  await page.getByRole("button", { name: "Create links" }).click();
  const id = await started;
  const firstLink = await page.getByLabel("Share link").inputValue();
  const deletion = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().endsWith(`/api/transfers/${id}`),
  );
  try {
    await expect(
      page.getByRole("status").filter({ hasText: "File 2 of 3" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel upload" }).click();
  } finally {
    releaseUpload();
  }
  expect((await deletion).status()).toBe(204);
  await expect(
    page.getByRole("status").filter({ hasText: "Upload cancelled." }),
  ).toBeVisible();
  expect(creations).toBe(2);
  expect((await request.get(`/api/transfers/${id}`)).status()).toBe(404);
  await expect(page.getByLabel("Share link")).toHaveValue(firstLink);
  await expect(
    page.getByRole("list", { name: "Selected files" }).getByRole("listitem"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Links ready" }),
  ).toBeVisible();
  expect(creations).toBe(4);
  expect(puts).toBe(4);
  await expect(page.getByLabel("Share link")).toHaveCount(3);
  await expect(
    page
      .getByRole("region", { name: "complete.txt", exact: true })
      .getByLabel("Share link"),
  ).toHaveValue(firstLink);
});
