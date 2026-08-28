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

// =============================================================================
// Production defect regression tests (ef905bb030fec6b9c9b268cf271fc50f0191e201
// follow-up): CSS/script leaking into anchorText/contextSnippet, template/
// hidden exclusion (aria-hidden deliberately excluded -- accessibility-tree
// membership is not rendered/page visibility), and skip-link chrome
// classification.
// =============================================================================

// --- <style> INSIDE the anchor itself must never enter anchorText ----------
{
  const html = `<article><p>See <a href="https://other.test/x"><style>.css-1xjj904{color:red;}</style>Rockstar Games</a> for more.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 1, `exactly one link extracted -- got ${links.length}`);
  assert(links[0].anchorText === "Rockstar Games", `CSS inside the anchor itself is excluded from anchorText -- got "${links[0]?.anchorText}"`);
}

// --- <style> as a SIBLING near the anchor must never enter contextSnippet ---
{
  const html = `<article><p><style>.css-1um7p1v{display:flex;}</style>Before text. <a href="https://other.test/x">link</a> After text.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(
    links[0].contextSnippet !== null && !links[0].contextSnippet.includes("css-1um7p1v") && !links[0].contextSnippet.includes("display"),
    `CSS from a sibling <style> is excluded from contextSnippet -- got "${links[0]?.contextSnippet}"`
  );
  assert(
    links[0].contextSnippet?.includes("Before text") ?? false,
    `valid visible text surrounding the excluded <style> sibling is still captured -- got "${links[0]?.contextSnippet}"`
  );
}

// --- <script> excluded from both anchorText and contextSnippet -------------
{
  const html = `<article><p><script>var x = "should never appear";</script>Real text before. <a href="https://other.test/x"><script>var y = "also never";</script>Real anchor text</a> Real text after.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].anchorText === "Real anchor text", `<script> inside the anchor is excluded from anchorText -- got "${links[0]?.anchorText}"`);
  assert(
    !links[0].contextSnippet?.includes("never appear") && !links[0].contextSnippet?.includes("should"),
    `<script> content is excluded from contextSnippet -- got "${links[0]?.contextSnippet}"`
  );
  assert(
    (links[0].contextSnippet?.includes("Real text before") || links[0].contextSnippet?.includes("Real text after")) ?? false,
    `valid visible text around excluded <script> siblings is still captured -- got "${links[0]?.contextSnippet}"`
  );
}

// --- <noscript> excluded from both fields -----------------------------------
{
  const html = `<article><p><noscript>fallback content, not real page text</noscript>Real before. <a href="https://other.test/x">link</a> Real after.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(
    !links[0].contextSnippet?.includes("fallback content"),
    `<noscript> content is excluded from contextSnippet -- got "${links[0]?.contextSnippet}"`
  );
}

// --- <a> inside <template> is discarded entirely, not merely blanked -------
// Also proves original DOM link_position semantics survive the discard:
// document order is [0]=template-nested (discarded), [1]=real link -- the
// real link must retain linkPosition 1, not be renumbered to 0.
{
  const html = `<article><p>
    <template><a href="https://other.test/never-rendered">inert</a></template>
    <a href="https://other.test/real">real link</a>
  </p></article>`;
  const { links, totalAnchorsEncountered } = extractLinks(html, PAGE_URL);
  assert(totalAnchorsEncountered === 2, `both anchors counted as raw-encountered -- got ${totalAnchorsEncountered}`);
  assert(links.length === 1, `the <template>-nested anchor is discarded entirely, not staged -- got ${links.length} link(s)`);
  assert(links[0]?.targetUrl === "https://other.test/real", "the surviving link is the real, non-template one");
  assert(links[0]?.linkPosition === 1, `surviving link retains its TRUE original DOM position (1), not renumbered to 0 -- got ${links[0]?.linkPosition}`);
}

// --- <a> inside a `hidden` subtree is discarded entirely --------------------
{
  const html = `<article><p>
    <span hidden><a href="https://other.test/hidden-link">hidden</a></span>
    <a href="https://other.test/visible">visible link</a>
  </p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 1 && links[0].targetUrl === "https://other.test/visible", `hidden-subtree anchor discarded, visible sibling survives -- got ${links.length} link(s)`);
  assert(links[0]?.linkPosition === 1, `surviving link retains its true original position despite the earlier discard -- got ${links[0]?.linkPosition}`);
}

// --- HTML entities in anchor text are DECODED, not left raw -- proves
// visibleText() uses the TextNode's decoded .text, not .rawText ------------
{
  const html = `<article><p>See <a href="https://other.test/x">Rockstar &amp; Take-Two</a> for more.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].anchorText === "Rockstar & Take-Two", `HTML entities in anchorText are decoded (&amp; -> &), not left as raw markup -- got "${links[0]?.anchorText}"`);
}
{
  const html = `<article><p>See <a href="https://other.test/x">the &quot;definitive&quot; guide</a> for more.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].anchorText === `the "definitive" guide`, `a second ordinary HTML entity (&quot; -> ") is also decoded in anchorText -- got "${links[0]?.anchorText}"`);
}
// --- HTML entities in contextSnippet are likewise decoded -------------------
{
  const html = `<article><p>Rockstar &amp; Take-Two announced <a href="https://other.test/x">this</a> today.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(
    links[0].contextSnippet?.includes("Rockstar & Take-Two") ?? false,
    `HTML entities in contextSnippet's surrounding sibling text are decoded, not left raw -- got "${links[0]?.contextSnippet}"`
  );
}

// --- aria-hidden="true" is NOT a visual-exclusion signal -- it affects the
// accessibility tree, not rendered/page visibility. Both an aria-hidden="true"
// descendant's actual visible text AND an <a> inside an aria-hidden="true"
// ancestor must be treated identically to ordinary visible content. --------
{
  const html = `<article><p>
    <span aria-hidden="true"><a href="https://other.test/aria-true">aria true link</a></span>
    <span aria-hidden="false"><a href="https://other.test/aria-false">aria false link</a></span>
  </p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links.length === 2, `aria-hidden="true" does NOT cause the anchor to be discarded -- both anchors survive -- got ${links.length} link(s)`);
  assert(links.some((l) => l.targetUrl === "https://other.test/aria-true"), "the aria-hidden=\"true\" anchor is present, not discarded solely for that reason");
  assert(links.some((l) => l.targetUrl === "https://other.test/aria-false"), "the aria-hidden=\"false\" anchor is unaffected either way");
  const ariaTrueLink = links.find((l) => l.targetUrl === "https://other.test/aria-true");
  assert(ariaTrueLink?.anchorText === "aria true link", `an aria-hidden="true" anchor's own visible text is preserved, not blanked -- got "${ariaTrueLink?.anchorText}"`);
}
{
  const html = `<article><p>Before real text. <a href="https://other.test/x">link</a> <span aria-hidden="true">aria-hidden but visually rendered text</span> After real text.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(
    links[0].contextSnippet?.includes("aria-hidden but visually rendered") ?? false,
    `text inside an aria-hidden="true" sibling is NOT excluded from contextSnippet -- accessibility-tree removal is not visual removal -- got "${links[0]?.contextSnippet}"`
  );
}

// --- image-only anchor still safe alongside a <style> sibling ---------------
{
  const html = `<article><p><style>.decoy{color:blue;}</style>Before image link. <a href="https://other.test/img"><img src="pic.png"/></a> After image link.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].anchorText === null, "image-only anchor next to a <style> sibling still has null anchorText");
  assert(
    !links[0].contextSnippet?.includes("decoy") && (links[0].contextSnippet?.includes("Before image link") ?? false),
    `contextSnippet excludes the <style> decoy and retains real surrounding text -- got "${links[0]?.contextSnippet}"`
  );
}

// --- explicit class/id skip-link signal on the anchor itself -> chrome -----
{
  const html = `<div><a class="skip-link" href="/somewhere">Jump past nav</a></div>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "chrome", `class="skip-link" on the anchor itself classifies as chrome -- got ${links[0]?.placement}`);
}

// --- ordinary content-*/nav-* class on the anchor's own attributes is UNCHANGED
// by adding skip-link handling (no "skip" token present at all) -----------
{
  const html = `<article><p>See <a class="content-link" href="https://other.test/x">this report</a>.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "content", `anchor's own class="content-link" (no skip token) is unaffected -- got ${links[0]?.placement}`);
}
{
  const html = `<div class="site-nav"><a class="nav-link" href="https://example.test/home">Home</a></div>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "chrome", `ordinary nav link (ancestor <nav>-token, no "skip") still classifies via the UNCHANGED generic walk -- got ${links[0]?.placement}`);
}

// --- the actual production semantic pattern: href="#..." + "Skip to Content" -> chrome
{
  const html = `<body><a href="#content"><style>.css-1xjj904{color:red}</style>Skip to Content</a><header><nav><a href="/">Home</a></nav></header><main><article><p>text</p></article></main></body>`;
  const { links } = extractLinks(html, PAGE_URL);
  const skip = links.find((l) => l.anchorText === "Skip to Content");
  assert(skip !== undefined, "the skip-link survives extraction with CSS cleaned out of its anchorText");
  assert(skip?.placement === "chrome", `href="#content" + cleaned text "Skip to Content" classifies as chrome via the semantic signal -- got ${skip?.placement}`);
}

// --- unrelated same-page fragment link with unrelated text remains content --
{
  const html = `<article><p>See the <a href="#specifications">Specifications</a> section below.</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement === "content", `href="#specifications" + text "Specifications" (not an approved skip phrase) remains content -- got ${links[0]?.placement}`);
}

// --- skip-intro / skip-ad must not become chrome from a bare "skip" --------
{
  const html = `<article><p><a class="skip-intro" href="#video">Skip Intro</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement !== "chrome", `class="skip-intro" (bare "skip", no qualifier co-occurrence) must NOT become chrome -- got ${links[0]?.placement}`);
}
{
  const html = `<article><p><a href="#ad">Skip Ad</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].placement !== "chrome", `"Skip Ad" text (not an approved exact phrase) must NOT become chrome via the semantic signal -- got ${links[0]?.placement}`);
}

// --- strict <= 300 bounds remain green after the exclusion-helper rewrite --
{
  const longText = "word ".repeat(100).trim();
  const html = `<article><p><a href="https://other.test/x"><style>.noise{color:red}</style>${longText}</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].anchorText !== null && links[0].anchorText.length <= ANCHOR_TEXT_MAX_LENGTH, `anchorText remains strictly <= ${ANCHOR_TEXT_MAX_LENGTH} even with CSS excluded first -- got length ${links[0]?.anchorText?.length}`);
}
{
  const before = "b".repeat(400);
  const after = "a".repeat(400);
  const html = `<article><p><style>.noise{color:red}</style>${before} <a href="https://other.test/x">link</a> ${after}</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(links[0].contextSnippet !== null && links[0].contextSnippet.length <= LINK_CONTEXT_SNIPPET_MAX_LENGTH, `contextSnippet remains strictly <= ${LINK_CONTEXT_SNIPPET_MAX_LENGTH} -- got length ${links[0]?.contextSnippet?.length}`);
}

// =============================================================================
// Full-ancestor-chain / unbounded-depth regression tests (review follow-up):
// isWithinNonVisibleSubtree() must inspect the COMPLETE ancestor chain, not
// a bounded walk, and visibleText() must never silently drop legitimate
// visible text past an arbitrary nesting depth.
// =============================================================================

// --- anchor nested MORE than 25 levels deep inside a `hidden` ancestor -----
// (25 = MAX_PLACEMENT_ANCESTOR_DEPTH, the UNRELATED generic-placement
// heuristic bound) is still discarded -- proves isWithinNonVisibleSubtree()
// does NOT reuse that bound and walks the full chain to the document root.
{
  const NESTING_LEVELS = 30; // intentionally > MAX_PLACEMENT_ANCESTOR_DEPTH (25)
  let deepChain = `<a href="https://other.test/deep-hidden-link">deep hidden link</a>`;
  for (let i = 0; i < NESTING_LEVELS; i++) {
    deepChain = `<div>${deepChain}</div>`;
  }
  const html = `<article><p><div hidden>${deepChain}</div><a href="https://other.test/visible-after">visible after</a></p></article>`;
  const { links, totalAnchorsEncountered } = extractLinks(html, PAGE_URL);
  assert(totalAnchorsEncountered === 2, `both anchors counted as raw-encountered despite the deep hidden nesting -- got ${totalAnchorsEncountered}`);
  assert(
    links.length === 1 && links[0].targetUrl === "https://other.test/visible-after",
    `an anchor ${NESTING_LEVELS}+ levels inside a \`hidden\` ancestor is discarded even though the ancestor sits far deeper than MAX_PLACEMENT_ANCESTOR_DEPTH (25) -- got ${links.length} link(s)`
  );
  assert(
    links[0]?.linkPosition === 1,
    `the surviving visible link retains its TRUE original DOM position (1), not renumbered to 0, despite the deep discard -- got ${links[0]?.linkPosition}`
  );
}

// --- equivalent deep case for <template> ------------------------------------
{
  const NESTING_LEVELS = 28; // still > MAX_PLACEMENT_ANCESTOR_DEPTH (25)
  let deepChain = `<a href="https://other.test/deep-template-link">deep template link</a>`;
  for (let i = 0; i < NESTING_LEVELS; i++) {
    deepChain = `<div>${deepChain}</div>`;
  }
  const html = `<article><p><template>${deepChain}</template><a href="https://other.test/visible-after-template">visible after template</a></p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(
    links.length === 1 && links[0].targetUrl === "https://other.test/visible-after-template",
    `an anchor ${NESTING_LEVELS}+ levels inside a <template> is discarded regardless of nesting depth -- got ${links.length} link(s)`
  );
}

// --- legitimate visible text nested MORE than 100 levels deep (the OLD,
// now-removed recursion cutoff) is still fully extracted, never silently
// dropped -----------------------------------------------------------------
{
  const NESTING_LEVELS = 150; // intentionally > the removed 100-level cutoff
  const deepPhrase = "deeply nested legitimate visible text";
  let deepChain = deepPhrase;
  for (let i = 0; i < NESTING_LEVELS; i++) {
    deepChain = `<span>${deepChain}</span>`;
  }
  const html = `<article><p>Before deep text. <a href="https://other.test/x">link</a> ${deepChain}</p></article>`;
  const { links } = extractLinks(html, PAGE_URL);
  assert(
    links[0].contextSnippet !== null && links[0].contextSnippet.includes("deeply nested legitimate"),
    `visible text nested ${NESTING_LEVELS} levels deep is still extracted in full, not silently dropped past the old cutoff -- got "${links[0]?.contextSnippet}"`
  );
}

if (failures > 0) {
  console.error(`\n${failures} link extraction check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll link extraction checks passed.");
}
