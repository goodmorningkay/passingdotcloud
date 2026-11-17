import { listReports, reviewReport, ReviewError } from "./review";

const [command, id, reportId, ...extra] = process.argv.slice(2);
const directory = process.env.PASSING_DATA_DIR ?? "./data";
try {
  if (command === "list" && !id && !reportId && !extra.length) {
    // JSON escapes untrusted comment text. Output goes only to this owner command.
    process.stdout.write(
      JSON.stringify(await listReports(directory), null, 2) + "\n",
    );
  } else if (
    (command === "approve" || command === "delete") &&
    id &&
    reportId &&
    !extra.length
  ) {
    await reviewReport(directory, id, reportId, command);
    process.stdout.write(
      command === "approve"
        ? "The report is closed. The original expiry and download limits still apply.\n"
        : "The file is blocked and queued for deletion. The API cleanup will remove it.\n",
    );
  } else {
    throw new ReviewError(
      "Use: npm run reports -- list | approve <file-id> <report-id> | delete <file-id> <report-id>",
    );
  }
} catch (error) {
  process.stderr.write(
    (error instanceof ReviewError
      ? error.message
      : "The report command failed. Check the data directory, permissions, and API setup.") +
      "\n",
  );
  process.exitCode = 1;
}
