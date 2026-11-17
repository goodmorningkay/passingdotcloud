import { test, expect } from "@playwright/test";
import { testSite } from "./site";

test("Home Screen metadata and icons work on each app route", async ({
  page,
  request,
  browserName,
}) => {
  for (const route of [
    "/",
    "/help",
    "/donate",
    "/install",
    "/privacy",
    "/report",
    `/t/${"a".repeat(32)}#invalid-test-key`,
  ]) {
    const response = await page.goto(route);
    expect(response?.ok()).toBe(true);
    expect(response?.headers()["cache-control"]).toContain("no-store");
    expect(response?.headers()["cache-control"]).toContain("no-transform");
    await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
    await expect(
      page.locator('head meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute("content", "passing.cloud");
    await expect(page.locator('head meta[name="viewport"]')).toHaveAttribute(
      "content",
      /viewport-fit=cover/,
    );
    await expect(
      page.locator('head meta[name="viewport"]'),
    ).not.toHaveAttribute("content", /user-scalable=no|maximum-scale=1(?:,|$)/);
    await expect(
      page.locator('head link[rel="apple-touch-icon"]'),
    ).toHaveAttribute("sizes", "180x180");

    const publicPage = route === "/" || route === "/help";
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute(
      "content",
      publicPage ? "index, follow" : "noindex, nofollow",
    );
    await expect(page.locator('head link[rel="canonical"]')).toHaveCount(
      publicPage ? 1 : 0,
    );
    if (publicPage) {
      await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
        "href",
        route === "/" ? testSite.origin : `${testSite.origin}/help`,
      );
    }
    await expect(page.locator('head meta[property="og:url"]')).toHaveAttribute(
      "content",
      route === "/help" ? `${testSite.origin}/help` : testSite.origin,
    );
    const image = page.locator('head meta[property="og:image"]');
    const imageUrl = new URL((await image.getAttribute("content"))!);
    expect(imageUrl.origin).toBe(testSite.origin);
    expect(imageUrl.pathname).toBe("/opengraph-image");
    await expect(
      page.locator('head meta[name="twitter:card"]'),
    ).toHaveAttribute("content", "summary_large_image");
    await expect(
      page.locator('head meta[name="twitter:image"]'),
    ).toHaveAttribute("content", (await image.getAttribute("content"))!);
  }

  const previewUrl = new URL(
    (await page
      .locator('head meta[property="og:image"]')
      .getAttribute("content"))!,
  );
  const preview = await request.get(previewUrl.pathname + previewUrl.search);
  expect(preview.ok()).toBe(true);
  expect(preview.headers()["content-type"]).toContain("image/png");
  const previewPng = await preview.body();
  expect(previewPng.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect([previewPng.readUInt32BE(16), previewPng.readUInt32BE(20)]).toEqual([
    1200, 630,
  ]);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  const sitemapUrls = [
    ...(await sitemap.text()).matchAll(/<loc>(.*?)<\/loc>/g),
  ];
  expect(sitemapUrls.map((match) => match[1])).toEqual([
    testSite.origin,
    `${testSite.origin}/help`,
  ]);
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  const robotsText = await robots.text();
  expect(robotsText).toContain("Disallow: /api/");
  expect(robotsText).toContain(`Sitemap: ${testSite.origin}/sitemap.xml`);

  // Fetch from a share page under the production CSP. The installed app must
  // have a stable identity and start at home, without a transfer ID or key.
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="manifest"]',
    )!;
    const response = await fetch(link.href);
    if (!response.ok) throw new Error("The app manifest is not available.");
    if (
      !response.headers
        .get("content-type")
        ?.includes("application/manifest+json")
    ) {
      throw new Error("The app manifest has an incorrect content type.");
    }
    return response.json();
  });
  expect(manifest).toMatchObject({
    id: "/",
    name: "passing.cloud",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(["192x192", "512x512"]),
  );

  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    const result = await session.send("Page.getAppManifest");
    expect(result.errors).toEqual([]);
    expect(JSON.parse(result.data!)).toEqual(manifest);
    await session.detach();
  }

  const appleIcon = await page
    .locator('head link[rel="apple-touch-icon"]')
    .getAttribute("href");
  for (const icon of [
    ...manifest.icons,
    { src: appleIcon, sizes: "180x180" },
  ]) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
    const png = await response.body();
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
  }

  await page.goto(manifest.start_url);
  await expect(page.getByRole("button", { name: "Create link" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).hash).toBe("");
});

test.describe("help without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("navigates between install, help, privacy, and home", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("link", { name: "Install", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Add to Home Screen" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Send files", exact: true }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Help", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "How to send a file", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "privacy page" }).click();
    await expect(page).toHaveURL("/privacy");
    await page.goBack();
    await expect(
      page.getByRole("link", { name: testSite.feedbackEmail, exact: true }),
    ).toHaveAttribute("href", `mailto:${testSite.feedbackEmail}`);
    await page.getByRole("link", { name: "Send files", exact: true }).click();
    await expect(page).toHaveURL("/");
  });
});
