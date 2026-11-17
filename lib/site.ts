export const SITE_ORIGIN =
  process.env.PASSING_PUBLIC_ORIGIN ?? "http://127.0.0.1:3000";
export const FEEDBACK_EMAIL = process.env.PASSING_FEEDBACK_EMAIL?.trim();
export const BITCOIN_DONATION_ADDRESS =
  process.env.PASSING_BITCOIN_DONATION_ADDRESS?.trim();
export const SITE_TITLE = "passing.cloud — Free encrypted file transfer";
export const SITE_DESCRIPTION =
  "Send files without an account. Your browser encrypts each file. Choose when its link expires.";
export const SITE_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "passing.cloud — Send files without an account. Encrypted in your browser, with links that expire.",
};
