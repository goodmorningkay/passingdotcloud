import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "lib/**/*.test.ts",
      "components/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    testTimeout: 20_000,
    restoreMocks: true,
  },
});
