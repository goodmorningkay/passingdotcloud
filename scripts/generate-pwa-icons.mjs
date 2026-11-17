import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Next.js supplies sharp. Keep the cloud from the existing favicon, but use
// a solid square background so each device can apply its own icon shape.
const source = await readFile(
  new URL("../app/icon.svg", import.meta.url),
  "utf8",
);
const squareIcon = Buffer.from(source.replace(' rx="16"', ""));
await mkdir(new URL("../public/icons/", import.meta.url), { recursive: true });

for (const [size, file] of [
  [180, "../app/apple-icon.png"],
  [192, "../public/icons/icon-192.png"],
  [512, "../public/icons/icon-512.png"],
]) {
  await sharp(squareIcon)
    .resize(size, size)
    .removeAlpha()
    .png()
    .toFile(fileURLToPath(new URL(file, import.meta.url)));
}
