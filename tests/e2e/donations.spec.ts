import { test, expect } from "@playwright/test";
import decodeQr from "jsqr";
import { testSite } from "./site";

const address = testSite.donationAddress;

test("hides feedback and donation controls with default settings", async ({
  page,
}) => {
  const origin = process.env.PASSING_E2E_DEFAULT_WEB_ORIGIN;
  if (!origin)
    throw new Error("The server for default settings is unavailable.");

  await page.goto(origin);
  await expect(page.getByRole("link", { name: "Send feedback" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "Donate", exact: true }),
  ).toHaveCount(0);
  await page.goto(new URL("/help", origin).href);
  await expect(
    page.getByRole("heading", { name: "Send feedback" }),
  ).toHaveCount(0);
  await page.goto(new URL("/privacy", origin).href);
  await expect(
    page.getByRole("heading", { name: "Feedback by email" }),
  ).toHaveCount(0);
  const response = await page.goto(new URL("/donate", origin).href);
  expect(response?.status()).toBe(404);
});

test("copies the Bitcoin donation address from the footer page", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("link", { name: "Donate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Donate Bitcoin", exact: true }),
  ).toBeVisible();
  const qr = page.getByRole("img", { name: "Bitcoin payment QR code" });
  const size = 256;
  const pixels = await qr.evaluate(async (image: HTMLImageElement, size) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("The QR code could not be read.");
    drawing.drawImage(image, 0, 0, size, size);
    return Array.from(drawing.getImageData(0, 0, size, size).data);
  }, size);
  expect(decodeQr(Uint8ClampedArray.from(pixels), size, size)?.data).toBe(
    `bitcoin:${address}`,
  );
  await expect(page.getByLabel("Bitcoin address")).toHaveValue(address);
  await expect(
    page.getByRole("link", { name: "Open Bitcoin wallet" }),
  ).toHaveAttribute("href", `bitcoin:${address}`);

  await page.getByRole("button", { name: "Copy address", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    address,
  );
});

test("selects the donation address when clipboard access is blocked", async ({
  page,
  context,
}) => {
  await page.goto("/donate");
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.send("Browser.setPermission", {
    browserContextId: targetInfo.browserContextId,
    permission: { name: "clipboard-write" },
    setting: "denied",
    origin: new URL(page.url()).origin,
  });
  await page.getByRole("button", { name: "Copy address", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Address selected. Copy it from the field.",
  );
  const field = page.getByLabel("Bitcoin address");
  await expect(field).toBeFocused();
  expect(
    await field.evaluate((element: HTMLTextAreaElement) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    ),
  ).toBe(address);
  await session.detach();
});
