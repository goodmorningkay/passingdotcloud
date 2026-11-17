import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { testSite } from "./site";

async function responds(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    return true;
  } catch {
    return false;
  }
}

function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address() as AddressInfo;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export default async function setup() {
  const root = process.cwd();
  const webPort = Number(process.env.PASSING_E2E_WEB_PORT ?? 3000);
  const apiPort = Number(process.env.PASSING_E2E_API_PORT ?? 4000);
  if ((await responds(webPort)) || (await responds(apiPort))) {
    throw new Error(
      `Stop the local servers on ports ${webPort} and ${apiPort} before browser tests.`,
    );
  }
  const testRoot = path.join(root, ".test-data");
  await mkdir(testRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(testRoot, "e2e-"));
  process.env.PASSING_E2E_DATA_DIR = dataDir;
  const children: ChildProcess[] = [];
  let startupError = false;

  function run(args: string[], extraEnv: NodeJS.ProcessEnv) {
    // Start each Node process directly. This also permits shutdown on Windows
    // without taskkill /T, which is unavailable in some restricted workspaces.
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...extraEnv },
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {
      startupError = true;
    });
    children.push(child);
    return child;
  }

  function startWeb(
    port: number,
    settings?: Pick<typeof testSite, "feedbackEmail" | "donationAddress">,
  ) {
    return run(
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        NODE_ENV: "production",
        API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        PASSING_PUBLIC_ORIGIN: testSite.origin,
        PASSING_FEEDBACK_EMAIL: settings?.feedbackEmail ?? "",
        PASSING_BITCOIN_DONATION_ADDRESS: settings?.donationAddress ?? "",
      },
    );
  }

  async function ready(port: number, child: ChildProcess) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (
        startupError ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error("A browser-test server could not start.");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return;
      } catch {
        /* The test server is still starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("A browser-test server did not become ready.");
  }

  async function stop() {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (
              child.exitCode !== null ||
              child.signalCode !== null ||
              !child.pid
            )
              return resolve();
            child.once("exit", () => resolve());
            child.kill("SIGTERM");
          }),
      ),
    );
    const resolvedRoot = await realpath(testRoot);
    const resolvedData = await realpath(dataDir);
    if (
      path.dirname(resolvedData) !== resolvedRoot ||
      !path.basename(resolvedData).startsWith("e2e-")
    ) {
      throw new Error("Unexpected test directory");
    }
    await rm(resolvedData, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }

  try {
    const api = run(["--import", "tsx", "server/index.ts"], {
      NODE_ENV: "development",
      PASSING_API_HOST: "127.0.0.1",
      PASSING_API_PORT: String(apiPort),
      PASSING_PUBLIC_ORIGIN: `http://127.0.0.1:${webPort}`,
      // Each browser test supplies its own network address through the local
      // Next proxy. Keep real per-network limits without sharing test quotas.
      PASSING_TRUST_PROXY: "127.0.0.1",
      PASSING_DATA_DIR: dataDir,
      // Synthetic key for the isolated admin browser tests. Never use in deployment.
      PASSING_ADMIN_KEY: "a".repeat(64),
    });
    await ready(apiPort, api);
    const web = startWeb(webPort, testSite);
    await ready(webPort, web);
    const defaultWebPort = await availablePort();
    const defaultWeb = startWeb(defaultWebPort);
    await ready(defaultWebPort, defaultWeb);
    process.env.PASSING_E2E_DEFAULT_WEB_ORIGIN = `http://127.0.0.1:${defaultWebPort}`;
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
