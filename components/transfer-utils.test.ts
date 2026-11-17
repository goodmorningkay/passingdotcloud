import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "@/lib/shared/constants";
import {
  formatBytes,
  formatExpiry,
  isCancelled,
  progressPercent,
  transferError,
  validateSelection,
} from "./transfer-utils";

describe("file selection", () => {
  it("accepts multiple files with a separate 100 MB limit for each", () => {
    expect(
      validateSelection([
        { name: "first.bin", size: MAX_FILE_BYTES } as File,
        { name: "second.bin", size: MAX_FILE_BYTES } as File,
        new File([], "empty.txt"),
      ]),
    ).toBeNull();
  });

  it("identifies an oversized file at any position in a selection", () => {
    const valid = { name: "valid.bin", size: MAX_FILE_BYTES } as File;
    const oversized = { name: "large.bin", size: MAX_FILE_BYTES + 1 } as File;
    for (const files of [
      [oversized, valid],
      [valid, oversized],
    ]) {
      expect(validateSelection(files)).toBe(
        "large.bin: This file is too large. Choose a file of 100 MB or less.",
      );
    }
  });

  it("rejects an empty drop", () => {
    expect(validateSelection([])).toBe("Choose at least one file.");
  });
});

describe("safe error guidance", () => {
  it("does not expose raw server or exception messages", () => {
    const untrusted = "secret-token /private/storage/file <script>";
    for (const action of [
      "upload",
      "download",
      "metadata",
      "delete",
      "expiry",
    ] as const) {
      expect(transferError(new Error(untrusted), action)).not.toContain(
        untrusted,
      );
      expect(
        transferError({ status: 500, message: untrusted }, action),
      ).not.toContain(untrusted);
    }
  });

  it("gives bounded integer retry guidance with a safe fallback", () => {
    expect(transferError({ status: 429, retryAfter: 2.2 }, "upload")).toContain(
      "Wait 3 seconds",
    );
    expect(transferError({ status: 429, retryAfter: 1 }, "download")).toContain(
      "Wait 1 second,",
    );
    for (const retryAfter of [undefined, 0, -1, NaN, Infinity, "30"]) {
      expect(transferError({ status: 429, retryAfter }, "metadata")).toContain(
        "Wait 60 seconds",
      );
    }
  });

  it("distinguishes connection failures, damaged files, and delete permissions", () => {
    expect(
      transferError(new TypeError("Failed to fetch"), "download"),
    ).toContain("connection");
    expect(
      transferError({ status: 0, code: "NETWORK_ERROR" }, "download"),
    ).toContain("connection");
    expect(
      transferError(new Error("Authentication failed"), "download"),
    ).toContain("key may be wrong");
    expect(transferError({ status: 403 }, "delete")).toContain("permission");
    expect(transferError(null, "upload")).toContain("try again");
  });

  it("recognizes browser cancellation without treating other errors as cancellation", () => {
    expect(isCancelled(new DOMException("Cancelled", "AbortError"))).toBe(true);
    expect(isCancelled(new Error("Network failure"))).toBe(false);
    expect(isCancelled(null)).toBe(false);
  });
});

describe("progress and file details", () => {
  it("keeps accessible progress values in range", () => {
    for (const [percent, expected] of [
      [-20, 0],
      [130, 100],
      [33.3, 33],
      [NaN, 0],
      [Infinity, 0],
    ]) {
      expect(
        progressPercent({
          stage: "uploading",
          loaded: 0,
          total: 1,
          percent: percent!,
        }),
      ).toBe(expected);
    }
    expect(progressPercent(null)).toBe(0);
  });

  it("uses decimal units consistent with the upload limit", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1_200)).toBe("1.2 KB");
    expect(formatBytes(MAX_FILE_BYTES)).toBe("100 MB");
  });

  it("includes a timezone in the expiry shown to a recipient", () => {
    expect(formatExpiry("2026-11-07T12:30:00.000Z")).toMatch(
      /7 Nov.*\d{2}:\d{2}.*(?:GMT|UTC)/,
    );
  });
});
