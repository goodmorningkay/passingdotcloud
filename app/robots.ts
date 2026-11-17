import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/site";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    // Allow crawlers to read the noindex directive on share pages.
    rules: { userAgent: "*", disallow: "/api/" },
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
