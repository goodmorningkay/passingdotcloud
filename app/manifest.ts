import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "passing.cloud",
    short_name: "passing.cloud",
    description: SITE_DESCRIPTION,
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#88bad5",
    theme_color: "#88bad5",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
