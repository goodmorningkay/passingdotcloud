import { createApp } from "./app";
import { loadConfig } from "./config";

try {
  const config = loadConfig();
  const app = await createApp();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await app.listen({ host: config.host, port: config.port });
} catch {
  // Never write an exception, URL, request, token, address, or path to logs.
  process.stderr.write("The API could not start.\n");
  process.exitCode = 1;
}
