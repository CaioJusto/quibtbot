import { type Locale, type PageKey, ROUTES } from "./i18n";
import { SITE_URL } from "./site";

/** Todas as páginas do site são públicas e indexáveis: não há rascunho escondido. */
export const INDEXABLE_PAGES: PageKey[] = ["home", "privacy", "terms"];
export const NOINDEX_PATHS: string[] = [];

const LOCALES = Object.keys(ROUTES) as Locale[];

export function absoluteUrl(pathname: string, base = SITE_URL) {
  return new URL(pathname, base).toString();
}

export type SitemapEntry = {
  locale: Locale;
  page: PageKey;
  url: string;
  alternates: { hreflang: string; url: string }[];
};

export function sitemapEntries(base = SITE_URL): SitemapEntry[] {
  return INDEXABLE_PAGES.flatMap((page) =>
    LOCALES.map((locale) => ({
      locale,
      page,
      url: absoluteUrl(ROUTES[locale][page], base),
      alternates: [
        ...LOCALES.map((alternate) => ({
          hreflang: alternate,
          url: absoluteUrl(ROUTES[alternate][page], base),
        })),
        { hreflang: "x-default", url: absoluteUrl(ROUTES.en[page], base) },
      ],
    })),
  );
}

export function sitemapXml(base = SITE_URL) {
  const urls = sitemapEntries(base)
    .map((entry) => {
      const alternates = entry.alternates
        .map(
          (alternate) =>
            `    <xhtml:link rel="alternate" hreflang="${alternate.hreflang}" href="${alternate.url}" />`,
        )
        .join("\n");
      return `  <url>\n    <loc>${entry.url}</loc>\n${alternates}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(base = SITE_URL) {
  return [
    "User-agent: *",
    "Allow: /",
    ...NOINDEX_PATHS.map((pathname) => `Disallow: ${pathname}`),
    "",
    `Sitemap: ${absoluteUrl("/sitemap.xml", base)}`,
    "",
  ].join("\n");
}
