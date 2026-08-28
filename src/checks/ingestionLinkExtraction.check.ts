/**
 * Regression check for src/lib/ingestion/linkExtraction.ts (Phase 6
 * prerequisite). Pure, no DB, no network.
 *
 * Run with: npx tsx src/checks/ingestionLinkExtraction.check.ts
 */
import {
  extractLinks,
  MAX_EXTRACTED_LINKS_PER_JOB,
  TARGET_URL_MAX_LENGTH,
  ANCHOR_TEXT_MAX_LENGTH,
  LINK_CONTEXT_SNIPPET_MAX_LENGTH,
} from "../lib/ingestion/linkExtraction";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const PAGE_URL = "https://example.test/article-1";

// --- content placement: inside <article> -----------------------------------
{
  const html = `<article><p>Some text <a href="https://other.test/x">a citation</a> here.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 1 && links[0].placement === "content", `link inside <article><p> classifies as content -- got ${links[0]?.placement}`);
}

// --- chrome placement: inside <nav> -----------------------------------------
{
  const html = `<nav><a href="https://example.test/home">Home</a></nav>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 1 && links[0].placement === "chrome", `link inside <nav> classifies as chrome -- got ${links[0]?.placement}`);
}

// --- chrome placement: class token match, boundary-aware -------------------
{
  const html = `<div class="site-nav"><a href="https://example.test/home">Home</a></div>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "chrome", "class='site-nav' (token 'nav') classifies as chrome");
}

// --- chrome token must NOT match via naive substring ------------------------
{
  const html = `<div class="navy-blue-button"><a href="https://other.test/x">Buy</a></div>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "ambiguous", `class='navy-blue-button' must NOT match the 'nav' token via substring -- got ${links[0]?.placement}`);
}

// --- "related" is explicitly NOT a chrome token -----------------------------
{
  const html = `<div class="related-stories"><a href="https://other.test/x">Related</a></div>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement !== "chrome", `class='related-stories' must NOT auto-classify as chrome -- got ${links[0]?.placement}`);
}

// --- ambiguous placement: no positive signal either way ---------------------
{
  const html = `<div><span><a href="https://other.test/x">link</a></span></div>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "ambiguous", `no positive content/chrome signal -> ambiguous -- got ${links[0]?.placement}`);
}

// --- ambiguous: same-element class collision (both chrome and content tokens) ---
{
  const html = `<div class="content-nav"><a href="https://other.test/x">x</a></div>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "ambiguous", `class matching BOTH chrome and content tokens on the same element -> ambiguous, never guessed -- got ${links[0]?.placement}`);
}

// --- content fallback: bare <p>, no container, no chrome ancestor -----------
{
  const html = `<p>Some paragraph text with <a href="https://other.test/x">a link</a> in it.</p>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "content", `bare <p> with no chrome ancestor -> content fallback -- got ${links[0]?.placement}`);
}

// --- same-site content link is legitimate, not reclassified -----------------
{
  const html = `<article><p>See our <a href="https://example.test/earlier-report">earlier report</a>.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "content" && links[0].isSameSite === true, "same-site link inside <article> is content AND same-site -- not reclassified as chrome merely for sharing a hostname");
}

// --- cross-site content link -------------------------------------------------
{
  const html = `<article><p>According to <a href="https://other-outlet.test/story">this report</a>.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "content" && links[0].isSameSite === false, "cross-site content link: placement=content, isSameSite=false");
}

// --- relative href resolution ------------------------------------------------
{
  const html = `<article><p><a href="/local-page">local</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].targetUrl === "https://example.test/local-page", `relative href resolved against pageUrl -- got ${links[0]?.targetUrl}`);
}

// --- absolute href resolution -------------------------------------------------
{
  const html = `<article><p><a href="https://other.test/page?x=1">x</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].targetUrl === "https://other.test/page?x=1", `absolute href preserved -- got ${links[0]?.targetUrl}`);
}

// --- fragment stripping -------------------------------------------------------
{
  const html = `<article><p><a href="https://other.test/page#section-2">x</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].targetUrl === "https://other.test/page", `fragment stripped from resolved target -- got ${links[0]?.targetUrl}`);
}

// --- mailto/javascript/tel rejected -------------------------------------------
{
  const html = `<article><p>
    <a href="mailto:x@example.test">mail</a>
    <a href="javascript:alert(1)">js</a>
    <a href="tel:+15551234567">tel</a>
    <a href="https://other.test/real">real</a>
  </p></article>`;
  const { links, totalAnchorsEncountered } = extractLinks(html, PAGE_URL);
  assert(totalAnchorsEncountered === 4, `all 4 anchors counted as encountered -- got ${totalAnchorsEncountered}`);
  assert(links.length === 1 && links[0].targetUrl === "https://other.test/real", "mailto/javascript/tel schemes are dropped entirely, only the real http(s) link survives");
}

// --- malformed URL rejected ----------------------------------------------------
{
  const html = `<article><p><a href="http://[not-valid-ipv6">x</a> <a href="https://other.test/ok">ok</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 1 && links[0].targetUrl === "https://other.test/ok", "malformed href (unparseable, throws in the URL constructor) is dropped, well-formed sibling link survives");
}

// --- credential-bearing URL rejected (normalizeUrl's existing policy) --------
{
  const html = `<article><p><a href="https://user:pass@other.test/x">x</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 0, "credential-bearing URL is dropped, per the existing normalizeUrl() credentials_present rejection -- reused, not reimplemented");
}

// --- target URL >2048 chars dropped, never truncated -------------------------
{
  const longPath = "a".repeat(TARGET_URL_MAX_LENGTH + 50);
  const html = `<article><p><a href="https://other.test/${longPath}">x</a> <a href="https://other.test/short">short</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 1 && links[0].targetUrl === "https://other.test/short", "over-length resolved URL is dropped entirely, not truncated -- only the short sibling link survives");
}

// --- anchor text truncation, word-boundary + ellipsis ------------------------
{
  const longText = "word ".repeat(100).trim();
  const html = `<article><p><a href="https://other.test/x">${longText}</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].anchorText !== null && links[0].anchorText.length <= ANCHOR_TEXT_MAX_LENGTH + 1, `anchor text truncated near ${ANCHOR_TEXT_MAX_LENGTH} chars -- got length ${links[0]?.anchorText?.length}`);
  assert(links[0].anchorText!.endsWith("…"), "truncated anchor text ends with ellipsis marker");
}

// --- context snippet truncation ----------------------------------------------
{
  const before = "b".repeat(400);
  const after = "a".repeat(400);
  const html = `<article><p>${before} <a href="https://other.test/x">link</a> ${after}</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].contextSnippet !== null && links[0].contextSnippet.length <= LINK_CONTEXT_SNIPPET_MAX_LENGTH, `context snippet bounded to ${LINK_CONTEXT_SNIPPET_MAX_LENGTH} chars -- got length ${links[0]?.contextSnippet?.length}`);
}

// --- context snippet: visible text only, no HTML tags ------------------------
{
  const html = `<article><p>Before <b>bold</b> text then <a href="https://other.test/x">link</a> then <i>italic</i> after.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(!links[0].contextSnippet?.includes("<"), "context snippet contains no HTML markup, only visible text");
}

// --- empty/image-only anchor text: no crash, no char-zero anchoring bug -----
{
  const html = `<article><p>Before this image link. <a href="https://other.test/x"><img src="pic.png"/></a> After the image link.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].anchorText === null, "image-only anchor has null anchorText");
  assert(
    links[0].contextSnippet !== null &&
      links[0].contextSnippet.includes("Before this image link") &&
      links[0].contextSnippet.includes("After the image link"),
    `empty anchor text still yields a real surrounding-text snippet (not anchored at char zero) -- got "${links[0]?.contextSnippet}"`
  );
}

// --- isolated anchor (sole child of parent): walks up for context -----------
{
  const html = `<article><p>Some earlier paragraph text.</p><p><a href="https://other.test/x">isolated link</a></p><p>Some later paragraph text.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(
    links[0].contextSnippet !== null &&
      (links[0].contextSnippet.includes("earlier paragraph") || links[0].contextSnippet.includes("later paragraph")),
    `an anchor that is the sole child of its <p> walks up to find real surrounding context -- got "${links[0]?.contextSnippet}"`
  );
}

// --- duplicate target at two positions preserved as two rows ----------------
{
  const html = `<article><p><a href="https://other.test/same">first</a> text <a href="https://other.test/same">second</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 2, `two occurrences of the same target are both kept -- got ${links.length}`);
  assert(links[0].linkPosition !== links[1].linkPosition, "duplicate-target occurrences have distinct link_position values");
}

// --- rel attribute captured ---------------------------------------------------
{
  const html = `<article><p><a href="https://other.test/x" rel="nofollow noopener">x</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].relAttribute === "nofollow noopener", `rel attribute captured verbatim (within bound) -- got "${links[0]?.relAttribute}"`);
}

// --- 200-link cap + priority selection (content > ambiguous > chrome) -------
{
  const navLinks = Array.from({ length: 50 }, (_, i) => `<a href="https://example.test/nav-${i}">n${i}</a>`).join("");
  const contentLinks = Array.from({ length: 220 }, (_, i) => `<a href="https://other.test/content-${i}">c${i}</a>`).join("");
  const html = `<nav>${navLinks}</nav><article><p>${contentLinks}</p></article>`;
  const { links, totalAnchorsEncountered } = extractLinks(html, PAGE_URL);
  assert(totalAnchorsEncountered === 270, `all 270 anchors counted as encountered -- got ${totalAnchorsEncountered}`);
  assert(links.length === MAX_EXTRACTED_LINKS_PER_JOB, `capped at exactly ${MAX_EXTRACTED_LINKS_PER_JOB} -- got ${links.length}`);
  assert(links.every((l) => l.placement === "content"), "cap prioritizes content links over chrome -- with 220 content links available, ALL 200 staged links are content, zero nav/chrome links survive the cap");
}

// --- cap does not naively take first-N by DOM order (would favor nav) ------
{
  const navLinks = Array.from({ length: 250 }, (_, i) => `<a href="https://example.test/nav-${i}">n${i}</a>`).join("");
  const contentLinks = Array.from({ length: 10 }, (_, i) => `<a href="https://other.test/content-${i}">c${i}</a>`).join("");
  // Nav appears FIRST in document order, content SECOND -- a naive
  // first-200-encountered cap would keep zero content links.
  const html = `<nav>${navLinks}</nav><article><p>${contentLinks}</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  const contentCount = links.filter((l) => l.placement === "content").length;
  assert(contentCount === 10, `all 10 content links survive the cap despite appearing after 250 nav links in document order -- got ${contentCount}`);
}

// --- stable original link_position despite cap/filtering --------------------
{
  const html = `<nav><a href="https://example.test/n0">n0</a></nav><article><p>
    <a href="mailto:x@example.test">dropped</a>
    <a href="https://other.test/c0">c0</a>
  </p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  // Document order of <a> tags: [0]=nav n0, [1]=mailto (dropped), [2]=c0.
  const c0 = links.find((l) => l.targetUrl === "https://other.test/c0");
  assert(c0?.linkPosition === 2, `link_position reflects TRUE original DOM position even though position 1 was filtered out -- got ${c0?.linkPosition}`);
}

if (failures > 0) {
  console.error(`\n${failures} link extraction check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll link extraction checks passed.");
}
