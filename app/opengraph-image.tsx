import { ImageResponse } from "next/og";
import { SITE_IMAGE } from "@/lib/site";

export const alt = SITE_IMAGE.alt;
export const size = { width: SITE_IMAGE.width, height: SITE_IMAGE.height };
export const contentType = "image/png";
export const dynamic = "force-static";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: 72,
        background: "#afcfdf",
        color: "#293f48",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", fontSize: 32 }}>passing.cloud</div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: 64,
          fontSize: 76,
          lineHeight: 1.1,
        }}
      >
        <span>Send files</span>
        <span>without an account</span>
      </div>
      <div style={{ display: "flex", marginTop: 32, fontSize: 28 }}>
        Encrypted in your browser · Links that expire
      </div>
      <svg
        width="300"
        height="300"
        viewBox="0 0 64 64"
        style={{ position: "absolute", right: 24, bottom: 0 }}
      >
        <path
          d="M17 45h31a9 9 0 0 0 .2-18A15 15 0 0 0 20 24a10.6 10.6 0 0 0-3 21Z"
          fill="#fafbf4"
        />
      </svg>
    </div>,
    size,
  );
}
