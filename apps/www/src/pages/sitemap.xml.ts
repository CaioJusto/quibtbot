import type { APIRoute } from "astro";
import { sitemapXml } from "../seo";

export const GET: APIRoute = () =>
  new Response(sitemapXml(), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
