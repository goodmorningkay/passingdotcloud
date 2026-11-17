export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export const unavailable = () =>
  new ApiFailure(503, "UNAVAILABLE", "The service is not available.");
export const missing = () =>
  new ApiFailure(404, "NOT_FOUND", "The transfer is not available.");
export const limited = (retryAfter = 60) =>
  new ApiFailure(
    429,
    "RATE_LIMITED",
    "Too many requests. Try again later.",
    retryAfter,
  );
