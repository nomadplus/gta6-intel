/**
 * Deterministic, basic metadata extraction from a fetched HTML document.
 *
 * Deliberately NOT a readability/article-body extractor -- this pulls
 * exactly the handful of fields the review/storage flow needs (title,
 * description/excerpt seed, canonical URL, author, published time, and
 * the JSON-LD `isAccessibleForFree` paywall signal) using fixed
 * precedence rules, documented inline at each field. Anything the
 * precedence rules can't determine is left `null` -- this module never
 * guesses.
 *
 * Uses `node-html-parser` (see PR discussion: chosen over `cheerio`
 * specifically because it has no HTTP-client-shaped dependency in its
 * tree). It never executes `<script>` content -- JSON-LD `<script>`
 * tags are read as plain text and passed through `JSON.parse` inside a
 * try/catch, same as any other untrusted string.
 */
import { parse, type HTMLElement } from "node-html-parser";

/** Hard cap matching the approved excerpt column policy (Section 6). */
export const EXCERPT_MAX_LENGTH = 500;

export interface ExtractedMetadata {
  title: string | null;
  /** Meta/OG description, used as the excerpt seed -- never full article text. */
  description: string | null;
  /** Short, hard-capped excerpt derived from `description`. */
  excerpt: string | null;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: Date | null;
  /**
   * true only on an explicit, well-formed JSON-LD `isAccessibleForFree:
   * false`. Absence of any signal, or a malformed/unparseable JSON-LD
   * block, is `null` -- never inferred as either true or false. See
   * Section 5 of the PR spec: this is the ONE high-confidence signal
   * this module is allowed to surface for paywall classification.
   */
  isAccessibleForFree: boolean | null;
}

function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function attr(el: HTMLElement | null, name: string): string | null {
  if (!el) return null;
  return textOrNull(el.getAttribute(name) ?? null);
}

/**
 * Title precedence, most to least specific:
 *   1. `og:title` meta content
 *   2. `<title>` element text
 * `og:title` is preferred first because publishers frequently pad the
 * `<title>` tag with a site-name suffix (" | Example News") that
 * `og:title` omits.
 */
function extractTitle(root: HTMLElement): string | null {
  const ogTitle = attr(root.querySelector('meta[property="og:title"]'), "content");
  if (ogTitle) return ogTitle;
  const titleEl = root.querySelector("title");
  return textOrNull(titleEl?.text ?? null);
}

/**
 * Description precedence:
 *   1. `og:description` meta content
 *   2. `meta[name="description"]` content
 */
function extractDescription(root: HTMLElement): string | null {
  const ogDesc = attr(root.querySelector('meta[property="og:description"]'), "content");
  if (ogDesc) return ogDesc;
  return attr(root.querySelector('meta[name="description"]'), "content");
}

/** Hard-caps a description into the excerpt column's approved length, on a word boundary where possible. */
function toExcerpt(description: string | null): string | null {
  if (!description) return null;
  if (description.length <= EXCERPT_MAX_LENGTH) return description;
  const truncated = description.slice(0, EXCERPT_MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  const safeCut = lastSpace > EXCERPT_MAX_LENGTH * 0.6 ? truncated.slice(0, lastSpace) : truncated;
  return `${safeCut.trimEnd()}…`;
}

/**
 * Canonical URL precedence:
 *   1. `<link rel="canonical" href="...">`
 *   2. `og:url` meta content
 * Only a syntactically valid absolute http(s) URL is returned --
 * malformed or relative canonical hints are discarded rather than
 * guessed-at, since a wrong canonical would corrupt duplicate detection.
 */
function extractCanonicalUrl(root: HTMLElement): string | null {
  const linkHref = attr(root.querySelector('link[rel="canonical"]'), "href");
  const ogUrl = attr(root.querySelector('meta[property="og:url"]'), "content");
  for (const candidate of [linkHref, ogUrl]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {
      // Not a valid absolute URL -- skip rather than guess.
    }
  }
  return null;
}

/**
 * Author precedence:
 *   1. `meta[name="author"]` content
 *   2. JSON-LD `author.name` (string or first array entry's `.name`)
 */
function extractAuthor(root: HTMLElement, jsonLd: Record<string, unknown>[]): string | null {
  const metaAuthor = attr(root.querySelector('meta[name="author"]'), "content");
  if (metaAuthor) return metaAuthor;

  for (const doc of jsonLd) {
    const author = doc.author;
    if (typeof author === "string") return textOrNull(author);
    if (Array.isArray(author) && author.length > 0) {
      const first = author[0];
      if (first && typeof first === "object" && "name" in first && typeof (first as { name: unknown }).name === "string") {
        return textOrNull((first as { name: string }).name);
      }
    }
    if (author && typeof author === "object" && "name" in author && typeof (author as { name: unknown }).name === "string") {
      return textOrNull((author as { name: string }).name);
    }
  }
  return null;
}

/**
 * Published-time precedence:
 *   1. `meta[property="article:published_time"]` content
 *   2. JSON-LD `datePublished`
 * Only a value `Date` can parse without producing `Invalid Date` is
 * returned -- a malformed timestamp is treated as absent, not guessed.
 */
function extractPublishedAt(root: HTMLElement, jsonLd: Record<string, unknown>[]): Date | null {
  const metaTime = attr(root.querySelector('meta[property="article:published_time"]'), "content");
  const candidates: (string | null)[] = [metaTime];
  for (const doc of jsonLd) {
    if (typeof doc.datePublished === "string") candidates.push(doc.datePublished);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/**
 * Parses every `<script type="application/ld+json">` block into a flat
 * array of plain objects. A JSON-LD `@graph` array or a top-level JSON
 * array is flattened one level; anything that fails to parse, or parses
 * to a non-object, is silently skipped rather than throwing -- malformed
 * JSON-LD on a third-party page is expected, not exceptional.
 */
function parseJsonLd(root: HTMLElement): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.text);
    } catch {
      continue;
    }
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const obj = candidate as Record<string, unknown>;
        results.push(obj);
        if (Array.isArray(obj["@graph"])) {
          for (const node of obj["@graph"] as unknown[]) {
            if (node && typeof node === "object" && !Array.isArray(node)) {
              results.push(node as Record<string, unknown>);
            }
          }
        }
      }
    }
  }
  return results;
}

/**
 * The ONLY high-confidence paywall signal this module surfaces (Section
 * 5): a well-formed JSON-LD node with `isAccessibleForFree` explicitly
 * `false` (boolean, or the strings `"false"`/`"False"` which some
 * publishers emit non-conformantly). `true`, missing, or any other
 * shape returns `null` (no signal) or `true` respectively -- never
 * inferred from body text, CSS classes, or a login form.
 */
function extractIsAccessibleForFree(jsonLd: Record<string, unknown>[]): boolean | null {
  for (const doc of jsonLd) {
    const value = doc.isAccessibleForFree;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "false") return false;
      if (value.toLowerCase() === "true") return true;
    }
  }
  return null;
}

/**
 * Extracts all fields in one pass over a parsed DOM. `html` should be
 * the `bodyText` returned by `safeFetch` for a `text/html` or
 * `application/xhtml+xml` response -- calling this on a non-HTML
 * content type is the caller's responsibility to avoid (see
 * `DEFAULT_ALLOWED_CONTENT_TYPES` in safeFetch.ts).
 */
export function extractMetadata(html: string): ExtractedMetadata {
  const root = parse(html, {
    // Comments and script/style contents are never used for extraction
    // beyond the explicit JSON-LD script handling above, so there is no
    // reason to retain them.
    comment: false,
  });

  const jsonLd = parseJsonLd(root);
  const description = extractDescription(root);

  return {
    title: extractTitle(root),
    description,
    excerpt: toExcerpt(description),
    canonicalUrl: extractCanonicalUrl(root),
    author: extractAuthor(root, jsonLd),
    publishedAt: extractPublishedAt(root, jsonLd),
    isAccessibleForFree: extractIsAccessibleForFree(jsonLd),
  };
}
