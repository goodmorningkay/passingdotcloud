import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { checkTransfer, TransferCheckError } from "./monitor-transfer";

const execute = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/;
const JOB = /^[0-9a-f]{40}-[0-9a-f]{16}$/;

export class DeploymentError extends Error {}

interface Run {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export function validateRun(runs: Run[], sha: string): Run {
  if (!COMMIT.test(sha))
    throw new DeploymentError("Use a full lowercase commit ID.");
  const run = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "main" &&
        run.event === "push",
    )
    .sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== "completed" || run.conclusion !== "success")
    throw new DeploymentError(
      "The latest CI run for this main commit must complete successfully.",
    );
  return run;
}

export function validateJobs(
  jobs: { name: string; conclusion: string | null }[],
): void {
  for (const name of ["check", "containers"])
    if (
      jobs.filter((job) => job.name === name).length !== 1 ||
      !jobs.some((job) => job.name === name && job.conclusion === "success")
    )
      throw new DeploymentError(`The CI job ${name} must pass.`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new DeploymentError(`Set ${name}.`);
  return value;
}

async function github<T>(route: string): Promise<T> {
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw new DeploymentError("The GitHub CI check failed.");
  return (await response.json()) as T;
}

async function gate(sha: string): Promise<Run> {
  if (required("GITHUB_REF") !== "refs/heads/main" || !COMMIT.test(sha))
    throw new DeploymentError(
      "Run this workflow from main with a full commit ID.",
    );
  const repository = required("GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new DeploymentError("The repository name is not valid.");
  try {
    await execute("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  } catch {
    throw new DeploymentError("The selected commit must belong to main.");
  }
  const base = `/repos/${repository}/actions`;
  const { workflow_runs: runs } = await github<{ workflow_runs: Run[] }>(
    `${base}/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`,
  );
  const run = validateRun(runs, sha);
  // This endpoint returns the latest run attempt. Do not accept old successful jobs.
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = await github<{
      total_count: number;
      jobs: { name: string; conclusion: string | null }[];
    }>(`${base}/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    if (page >= 10 || !result.jobs.length)
      throw new DeploymentError("The CI job list is incomplete.");
  }
  validateJobs(jobs);
  return run;
}

interface Status {
  id: string;
  sha: string;
  phase: string;
  stage?: string;
  worker_active?: boolean;
  updated_at?: number;
  last_successful?: string;
  images?: Record<string, { id: string }>;
}

export function validateServerOrigin(reply: unknown, origin: string): void {
  if (
    !reply ||
    typeof reply !== "object" ||
    !("origin" in reply) ||
    reply.origin !== origin
  )
    throw new DeploymentError(
      "The deployment server origin does not match PASSING_PRODUCTION_ORIGIN.",
    );
}

async function deploy(sha: string, run: Run): Promise<void> {
  const host = required("PASSING_DEPLOY_HOST");
  const user = required("PASSING_DEPLOY_USER");
  const port = process.env.PASSING_DEPLOY_PORT || "22";
  const origin = new URL(required("PASSING_PRODUCTION_ORIGIN"));
  if (
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    !/^[a-z_][a-z0-9_-]*$/.test(user) ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new DeploymentError(
      "The production connection settings are not valid.",
    );
  const directory = await mkdtemp(path.join(tmpdir(), "passing-deploy-"));
  const key = path.join(directory, "key");
  const knownHosts = path.join(directory, "known_hosts");
  let job: string | undefined;
  let successful = false;
  let lastSuccessful: string | undefined;
  let images: Status["images"];
  let phase = "preparation";
  try {
    await writeFile(key, required("PASSING_DEPLOY_KEY") + "\n", {
      mode: 0o600,
    });
    await writeFile(knownHosts, required("PASSING_DEPLOY_KNOWN_HOSTS") + "\n", {
      mode: 0o600,
    });
    const options = [
      "-F",
      "/dev/null",
      "-i",
      key,
      "-p",
      port,
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      `${user}@${host}`,
    ];
    async function remote(command: string[], input?: Buffer): Promise<unknown> {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn("ssh", [...options, command.join(" ")], {
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 150_000,
        });
        let result = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (data: string) => {
          result += data;
          if (result.length > 64_000) child.kill();
        });
        child.on("error", reject);
        child.stdin.on("error", () => {});
        child.on("close", (code) => {
          if (code === 0) resolve(result);
          else
            reject(new DeploymentError("The deployment SSH command failed."));
        });
        child.stdin.end(input);
      });
      let reply: unknown;
      try {
        reply = JSON.parse(output);
      } catch {
        throw new DeploymentError(
          "The server returned an invalid deployment status.",
        );
      }
      validateServerOrigin(reply, origin.origin);
      return reply;
    }
    async function remoteStatus(
      command: string[],
      input?: Buffer,
    ): Promise<Status> {
      const status = (await remote(command, input)) as Status;
      if (
        !JOB.test(status.id) ||
        status.sha !== sha ||
        (job && status.id !== job)
      )
        throw new DeploymentError(
          "The server deployment ID does not match this release.",
        );
      return status;
    }
    await remote(["info"]);
    const archivePath = path.join(directory, "release.tar");
    await execute("git", ["archive", "--format=tar", "-o", archivePath, sha]);
    const archive = await readFile(archivePath);
    const digest = createHash("sha256").update(archive).digest("hex");
    const expectedOrigin = Buffer.from(origin.origin).toString("hex");
    const started = await remoteStatus(
      ["deploy", sha, digest, expectedOrigin],
      archive,
    );
    job = started.id;
    lastSuccessful = started.last_successful;
    const deadline = Date.now() + 32 * 60_000;
    for (;;) {
      const status = await remoteStatus(["status", job]);
      if (status.phase === "awaiting-verification") break;
      if (
        ["failed", "failed-after-switch", "verification-failed"].includes(
          status.phase,
        ) ||
        (!status.worker_active &&
          (status.phase !== "queued" ||
            Date.now() / 1000 - (status.updated_at || 0) > 60)) ||
        Date.now() >= deadline
      )
        throw new DeploymentError(
          `The server deployment stopped during ${status.stage || status.phase}.`,
        );
      if (status.phase !== phase) {
        phase = status.phase;
        process.stdout.write(`Deployment stage: ${phase}.\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    phase = "public HTTPS";
    for (const route of ["/", "/api/health"]) {
      const response = await fetch(new URL(route, origin), {
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok)
        throw new DeploymentError("The public HTTPS check failed.");
      if (route === "/api/health") {
        const health = (await response.json()) as { ok?: boolean };
        if (health.ok !== true)
          throw new DeploymentError("The public API health check failed.");
      } else await response.body?.cancel();
    }
    phase = "transfer check";
    try {
      await checkTransfer(origin.origin);
    } catch (error) {
      if (error instanceof TransferCheckError)
        throw new DeploymentError(error.message);
      throw error;
    }
    const finished = await remoteStatus(["finish", job, "success"]);
    images = finished.images;
    successful = true;
    process.stdout.write(`Deployment passed for ${sha}.\n`);
  } finally {
    const summary = [
      `Production deployment: ${successful ? "passed" : "failed"}`,
      "",
      `Commit: \`${sha}\``,
      `Site: ${origin.origin}`,
      `CI: ${run.html_url}`,
      `Deployment ID: \`${job || "not received"}\``,
      `Previous successful commit: \`${lastSuccessful || "check server info"}\``,
      `Last stage: ${phase}`,
      "",
      successful
        ? "Public HTTPS and the upload, download, byte comparison, and deletion checks passed."
        : "Check the server status before another deployment. Resolve any pending deployment and review database compatibility before recovery.",
      ...Object.entries(images || {}).map(
        ([name, image]) => `${name} image: \`${image.id}\``,
      ),
      ...(successful
        ? []
        : [
            "",
            "Server commands:",
            "```sh",
            "sudo /usr/local/libexec/passing-cloud-deploy info",
            ...(job
              ? [
                  `sudo /usr/local/libexec/passing-cloud-deploy status ${job}`,
                  `sudo /usr/local/libexec/passing-cloud-deploy finish ${job} failure`,
                ]
              : []),
            `sudo /usr/local/libexec/passing-cloud-deploy recover ${lastSuccessful && COMMIT.test(lastSuccessful) ? lastSuccessful : "<saved-commit-id>"} --database-compatible`,
            "```",
          ]),
    ].join("\n");
    if (process.env.GITHUB_STEP_SUMMARY)
      await writeFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", {
        flag: "a",
      });
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const sha = required("RELEASE_SHA");
  const run = await gate(sha);
  if (process.argv[2] === "gate") {
    process.stdout.write(`CI passed for ${sha}.\n`);
  } else if (process.argv[2] === "deploy") {
    await deploy(sha, run);
  } else throw new DeploymentError("Use gate or deploy.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof DeploymentError
        ? error.message
        : "The deployment failed.") + "\n",
    );
    process.exitCode = 1;
  });
