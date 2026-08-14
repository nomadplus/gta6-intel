/**
 * Regression check for src/lib/ingestion/metadataExtraction.ts.
 *
 * Run with: npx tsx src/checks/ingestionMetadataExtraction.check.ts
 */
import { extractMetadata, EXCERPT_MAX_LENGTH } from "../lib/ingestion/metadataExtraction";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// --- Title precedence: og:title over <title> -----------------------------
{
  const html = `<html><head>
    <title>Page Title | Example News</title>
    <meta property="og:title" content="Page Title" />
  </head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.title === "Page Title", `og:title preferred over <title> -- got "${result.title}"`);
}

// --- Title fallback to <title> when no og:title ---------------------------
{
  const html = `<html><head><title>Only Title Tag</title></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.title === "Only Title Tag", `falls back to <title> -- got "${result.title}"`);
}

// --- Description precedence: og:description over meta description --------
{
  const html = `<html><head>
    <meta name="description" content="Generic description" />
    <meta property="og:description" content="OG description" />
  </head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.description === "OG description", `og:description preferred -- got "${result.description}"`);
}

// --- Excerpt hard cap -------------------------------------------------
{
  const longDescription = "A".repeat(EXCERPT_MAX_LENGTH + 200);
  const html = `<html><head><meta name="description" content="${longDescription}" /></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(
    result.excerpt !== null && result.excerpt.length <= EXCERPT_MAX_LENGTH + 1, // +1 for trailing ellipsis char
    `excerpt is hard-capped near ${EXCERPT_MAX_LENGTH} chars -- got length ${result.excerpt?.length}`
  );
}

{
  const shortDescription = "A short description under the cap.";
  const html = `<html><head><meta name="description" content="${shortDescription}" /></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.excerpt === shortDescription, "short description is used verbatim as excerpt, no truncation marker");
}

// --- Canonical URL extraction -------------------------------------------
{
  const html = `<html><head><link rel="canonical" href="https://example.com/canonical-path" /></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.canonicalUrl === "https://example.com/canonical-path", `canonical link extracted -- got "${result.canonicalUrl}"`);
}

{
  // Relative/malformed canonical hrefs are discarded, not guessed at.
  const html = `<html><head><link rel="canonical" href="/relative-path" /></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.canonicalUrl === null, "relative canonical href is discarded rather than resolved/guessed");
}

// --- Author extraction: meta[name=author] --------------------------------
{
  const html = `<html><head><meta name="author" content="Jane Doe" /></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.author === "Jane Doe", `author extracted from meta tag -- got "${result.author}"`);
}

// --- Author extraction: JSON-LD fallback ---------------------------------
{
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", author: { name: "John Smith" } })}</script>
  </head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.author === "John Smith", `author extracted from JSON-LD when no meta tag present -- got "${result.author}"`);
}

// --- publishedAt: meta tag ---------------------------------------------
{
  const html = `<html><head><meta property="article:published_time" content="2026-03-15T10:00:00Z" /></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(
    result.publishedAt !== null && result.publishedAt.toISOString() === "2026-03-15T10:00:00.000Z",
    `publishedAt extracted from meta tag -- got ${result.publishedAt?.toISOString()}`
  );
}

// --- publishedAt: JSON-LD fallback --------------------------------------
{
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", datePublished: "2026-01-01" })}</script>
  </head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.publishedAt !== null, "publishedAt extracted from JSON-LD datePublished when no meta tag present");
}

// --- publishedAt: malformed value is treated as absent --------------------
{
  const html = `<html><head><meta property="article:published_time" content="not-a-real-date" /></head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.publishedAt === null, "malformed published-time value is treated as absent, not guessed");
}

// --- isAccessibleForFree: JSON-LD false ----------------------------------
{
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", isAccessibleForFree: false })}</script>
  </head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.isAccessibleForFree === false, "JSON-LD isAccessibleForFree:false is surfaced as a high-confidence paywall signal");
}

// --- isAccessibleForFree: absence is null, not a guess ---------------------
{
  const html = `<html><head></head><body>Subscribe now to read more! <form>Login</form></body></html>`;
  const result = extractMetadata(html);
  assert(
    result.isAccessibleForFree === null,
    "no JSON-LD signal -- body text like 'Subscribe now' and a login form must NOT be inferred as paywalled"
  );
}

// --- @graph flattening ---------------------------------------------------
{
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "NewsArticle", author: { name: "Graph Author" }, isAccessibleForFree: false }],
    })}</script>
  </head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.author === "Graph Author", "author extracted from a JSON-LD @graph array");
  assert(result.isAccessibleForFree === false, "isAccessibleForFree extracted from a JSON-LD @graph array");
}

// --- Malformed JSON-LD is skipped, not thrown ------------------------------
{
  const html = `<html><head>
    <script type="application/ld+json">{ this is not valid json </script>
    <meta name="author" content="Fallback Author" />
  </head><body></body></html>`;
  let threw = false;
  let result;
  try {
    result = extractMetadata(html);
  } catch {
    threw = true;
  }
  assert(!threw, "malformed JSON-LD does not throw");
  assert(result?.author === "Fallback Author", "malformed JSON-LD is skipped; other extraction still proceeds");
}

// --- Fully empty document: everything null, nothing guessed ---------------
{
  const result = extractMetadata("<html><head></head><body></body></html>");
  assert(result.title === null, "empty document: title is null");
  assert(result.description === null, "empty document: description is null");
  assert(result.excerpt === null, "empty document: excerpt is null");
  assert(result.canonicalUrl === null, "empty document: canonicalUrl is null");
  assert(result.author === null, "empty document: author is null");
  assert(result.publishedAt === null, "empty document: publishedAt is null");
  assert(result.isAccessibleForFree === null, "empty document: isAccessibleForFree is null");
}

// --- Script content is never executed, only read as text -------------------
{
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ isAccessibleForFree: "false" })}</script>
  </head><body></body></html>`;
  const result = extractMetadata(html);
  assert(result.isAccessibleForFree === false, "non-conformant string 'false' in JSON-LD is still recognized");
}

if (failures > 0) {
  console.error(`\n${failures} metadata extraction check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll metadata extraction checks passed.");
}
