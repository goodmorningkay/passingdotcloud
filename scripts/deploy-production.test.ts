import { describe, expect, it } from "vitest";
import {
  validateJobs,
  validateRun,
  validateServerOrigin,
} from "./deploy-production";

const sha = "a".repeat(40);
const passed = {
  id: 10,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/example/app/actions/runs/10",
};

describe("production deployment CI gate", () => {
  it("accepts a successful push run for the full selected main commit", () => {
    expect(validateRun([passed], sha).id).toBe(10);
    expect(() =>
      validateJobs([
        { name: "check", conclusion: "success" },
        { name: "containers", conclusion: "success" },
      ]),
    ).not.toThrow();
  });

  it("rejects branch names and abbreviated commit IDs", () => {
    for (const value of ["main", sha.slice(0, 12), `${sha};id`])
      expect(() => validateRun([passed], value)).toThrow("full lowercase");
  });

  it("rejects another commit, a pull request run, and another branch", () => {
    for (const run of [
      { ...passed, head_sha: "b".repeat(40) },
      { ...passed, event: "pull_request" },
      { ...passed, head_branch: "feature" },
    ])
      expect(() => validateRun([run], sha)).toThrow("latest CI run");
  });

  it("rejects a newer failed or incomplete run even if an older run passed", () => {
    for (const state of [
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "cancelled" },
      { status: "in_progress", conclusion: null },
    ])
      expect(() =>
        validateRun([passed, { ...passed, id: 11, ...state }], sha),
      ).toThrow("latest CI run");
  });

  it("requires both CI jobs to pass, including container checks", () => {
    for (const jobs of [
      [{ name: "check", conclusion: "success" }],
      [
        { name: "check", conclusion: "success" },
        { name: "containers", conclusion: "skipped" },
      ],
      [
        { name: "check", conclusion: "success" },
        { name: "check", conclusion: "failure" },
        { name: "containers", conclusion: "success" },
      ],
    ])
      expect(() => validateJobs(jobs)).toThrow("must pass");
  });
});

it("requires the host to report the same origin as the public check", () => {
  const origin = "https://files.example.com";
  expect(() => validateServerOrigin({ origin }, origin)).not.toThrow();
  for (const reply of [{ origin: "https://staging.example.com" }, {}]) {
    expect(() => validateServerOrigin(reply, origin)).toThrow(
      "does not match PASSING_PRODUCTION_ORIGIN",
    );
  }
});
