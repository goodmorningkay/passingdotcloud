import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The root configuration is owned by the integration agent.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["components/**/*.test.ts"],
    restoreMocks: true,
  },
});
