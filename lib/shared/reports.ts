export const REPORT_COMMENT_MIN_LENGTH = 10;
export const REPORT_COMMENT_MAX_LENGTH = 1_000;

export function reportCommentError(comment: string): string | null {
  const text = comment.trim();
  if (
    text.length < REPORT_COMMENT_MIN_LENGTH ||
    text.length > REPORT_COMMENT_MAX_LENGTH
  )
    return "Enter a reason of 10 to 1000 characters.";
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
      text,
    )
  )
    return "The reason contains unsupported characters. Type it again.";
  // Prevent accidental inclusion of the standard 43-character share key.
  // This is an input guard, not a guarantee about all user-written content.
  if (/(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?:$|[^A-Za-z0-9_-])/u.test(text))
    return "Remove share links and encryption keys from the reason.";
  return null;
}
