import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  PASSING_PUBLIC_ORIGIN:
    process.env.PASSING_PUBLIC_ORIGIN ?? "http://127.0.0.1:3000",
};
const children = [
  spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "watch", "server/index.ts"],
    {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    },
  ),
  spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1"],
    {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    },
  ),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
