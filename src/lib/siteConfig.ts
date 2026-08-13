/**
 * Single source of truth for the site's public base URL.
 *
 * Used anywhere an absolute URL needs to be generated: metadataBase,
 * sitemap.ts, robots.ts, and any future canonical-URL or structured-data
 * usage. Previously this was hardcoded to "https://example.com" in three
 * separate files -- fixed during architecture review (see
 * docs/architecture.md "SEO base URL").
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL, if set -- the explicit override, and what
 *      should be set in Vercel for both staging and any future production
 *      custom domain.
 *   2. VERCEL_URL, if set -- Vercel provides this automatically for every
 *      deployment (preview and production) without configuration, so this
 *      is a reasonable fallback that keeps preview deploys correct without
 *      needing a project-level env var edit for every branch.
 *   3. http://localhost:3000 -- local development.
 */
function resolveSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

export const SITE_URL = resolveSiteUrl();
