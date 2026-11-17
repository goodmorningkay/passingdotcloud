import { reportCommentError } from "../shared/reports";
import { assertTransferId } from "./keys";
import { ApiError } from "./errors";
import { fetchApi, requireOk, responseJson } from "./http";

export async function reportTransfer(
  id: string,
  comment: string,
  signal?: AbortSignal,
): Promise<void> {
  assertTransferId(id);
  if (reportCommentError(comment))
    throw new ApiError(400, "INVALID_COMMENT", "Check the report comment.");
  const response = await fetchApi(`/api/transfers/${id}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comment: comment.trim() }),
    signal,
  });
  await requireOk(response, signal);
  const result = await responseJson(response, signal);
  if (
    response.status !== 202 ||
    !result ||
    typeof result !== "object" ||
    !("accepted" in result) ||
    result.accepted !== true
  )
    throw new ApiError(
      502,
      "INVALID_RESPONSE",
      "The server response is invalid.",
    );
}
