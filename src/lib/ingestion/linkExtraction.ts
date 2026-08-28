/**
 * Deterministic, structural outbound-link extraction from a fetched HTML
 * document (Phase 6 prerequisite).
 *
 * This module is an OBSERVATION extractor, not an inference engine -- same
 * boundary metadataExtraction.ts already draws for title/author/etc. It
 * answers only: "what <a> tags did this document contain, where did each
 * one resolve to, where did it sit structurally, and what visible text
 * surrounded it." It never decides whether a link constitutes a citation,
 * derivative, or any other epistemic relationship -- that judgment belongs
 * exclusively to analyse_provenance (AI, proposal-only) or a human via the
 * existing source_relationships admin form. There is deliberately no
 * "likely_citation"/"is_citation"-shaped output anywhere in this file.
 *
 * Pure, no I/O, no "server-only" dependency -- same convention as
 * urlNormalization.ts/relationshipCanonicalization.ts. Reuses the existing
 * normalizeUrl() verbatim for target-URL identity; this module never
 * reimplements URL normalization.
 *
 * PROVIDER-AGNOSTIC BY DESIGN: this file only knows how to read one HTML
 * document. It has no opinion about which discovery provider produced that
 * document (RSS-discovered article, manually submitted URL, or -- in a
 * later Phase 6 PR -- a forum/social-post adapter that produces equivalent
 * bounded evidence some other way). Nothing here assumes newspaper-article
 * structure beyond the DOM-placement heuristic itself, which degrades
 * safely to "ambiguous" for documents that don't match common CMS
 * conventions.
 */
import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { normalizeUrl } from "./urlNormalization";
import { extractHostname } from "./sourceIdentity";

// ---------------------------------------------------------------------------
// Bounds (all enforced HERE, before anything is staged/persisted -- see
// migrations 0026/0027's headers: the staging column must never receive an
// unbounded array to be filtered later).
// ---------------------------------------------------------------------------

/** Hard cap on extracted+staged links per ingestion job (Section 3 of the PR spec). */
export const MAX_EXTRACTED_LINKS_PER_JOB = 200;

/** Matches source_item_links.target_url / normalized_target_url column width. A resolved target exceeding this is DROPPED, never truncated -- a truncated URL is a different, broken URL. */
export const TARGET_URL_MAX_LENGTH = 2048;

/** Matches source_item_links.anchor_text column width. Truncated (word boundary + ellipsis), never dropped. */
export const ANCHOR_TEXT_MAX_LENGTH = 300;

/** Matches source_item_links.link_context_snippet column width. Truncated, never dropped. Approved: bounded, whitespace-normalized VISIBLE TEXT only -- never serialized HTML, never full-article text. */
export const LINK_CONTEXT_SNIPPET_MAX_LENGTH = 300;

/** Matches source_item_links.rel_attribute column width. Truncated (real-world rel values are short tokens; this is defense-in-depth, essentially never hit). */
export const REL_ATTRIBUTE_MAX_LENGTH = 200;

/** How many characters of "before" and "after" sibling text the context-snippet walk targets, before the final combined-string cap below is applied. Half of LINK_CONTEXT_SNIPPET_MAX_LENGTH each, so a full anchor-text-in-the-middle window still fits the overall cap in the common case. */
const CONTEXT_HALF_WINDOW_CHARS = 150;

/** How many ancestor levels the placement heuristic will walk before giving up and returning "ambiguous" -- a defensive bound against pathological/deeply-nested documents, not a tuned content signal. */
const MAX_PLACEMENT_ANCESTOR_DEPTH = 25;

/** How many levels the context-snippet walk will climb looking for non-trivial sibling text, if the anchor's immediate parent has none. */
const MAX_CONTEXT_ANCESTOR_DEPTH = 3;

export type LinkPlacement = "content" | "chrome" | "ambiguous";

export interface ExtractedLink {
  /**
   * 0-indexed encounter order among ALL <a> tags in the document, assigned
   * BEFORE any filtering (invalid scheme, over-length URL) or capping --
   * a stable per-fetch identity, not a compacted array index. The
   * original DOM link_position is preserved even for links that are
   * ultimately excluded by the priority cap (see extractLinks below) --
   * this field on a link that DOES make it into the returned array always
   * reflects its true original position.
   */
  linkPosition: number;
  /** Resolved absolute http(s) URL, fragment stripped. Never present if it exceeded TARGET_URL_MAX_LENGTH or failed normalizeUrl(). */
  targetUrl: string;
  /** normalizeUrl(targetUrl) -- same identity policy as source_items.normalized_url. */
  normalizedTargetUrl: string;
  /** Trimmed, whitespace-collapsed, word-boundary truncated to ANCHOR_TEXT_MAX_LENGTH. Null for an anchor with no text (e.g. image-only). */
  anchorText: string | null;
  /** Bounded, whitespace-normalized VISIBLE TEXT surrounding this link (built from DOM siblings, not from HTML serialization). Null if no surrounding text could be found at all. */
  contextSnippet: string | null;
  /** Raw rel="" attribute value, truncated. Null if absent. */
  relAttribute: string | null;
  /** Purely structural DOM-placement observation -- see this module's header. Never an epistemic conclusion. */
  placement: LinkPlacement;
  /** hostname(targetUrl) === hostname(pageUrl), exact match, no www-stripping (same convention as sourceIdentity.ts's extractHostname()). A purely factual signal, independent of placement -- a same-site link is never reclassified as chrome merely because it shares a hostname. */
  isSameSite: boolean;
}

export interface LinkExtractionResult {
  /** Already filtered (valid scheme, within URL length bound, successfully normalized) and capped at MAX_EXTRACTED_LINKS_PER_JOB, ordered content-first/ambiguous/chrome-last, ties broken by linkPosition ascending -- see the priority-cap comment below for why. */
  links: ExtractedLink[];
  /** Raw count of <a> tags encountered before any filtering/capping -- observability only, never persisted as its own column. */
  totalAnchorsEncountered: number;
}

// ---------------------------------------------------------------------------
// Placement heuristic
// ---------------------------------------------------------------------------

const CHROME_ANCESTOR_TAGS = new Set(["nav", "header", "footer", "aside"]);
const CONTENT_ANCESTOR_TAGS = new Set(["article", "main"]);

/**
 * Deliberately small, explicit token lists -- same conservative philosophy
 * already locked in for urlNormalization.ts's TRACKING_PARAMETERS: extend
 * only when a new token is actually observed and approved, never broadened
 * speculatively. "related" is DELIBERATELY EXCLUDED from the chrome list --
 * "related stories" links may be genuine provenance/discovery evidence and
 * must not be auto-classified as chrome just because a class/id contains
 * that word.
 */
const CHROME_CLASS_ID_TOKENS = new Set([
  "nav",
  "navigation",
  "menu",
  "sidebar",
  "breadcrumb",
  "pagination",
  "share",
  "social",
  "subscribe",
  "newsletter",
  "cookie",
]);

/** Positive content-container signal (Section 5: content requires this, not merely "not chrome"). */
const CONTENT_CLASS_ID_TOKENS = new Set(["article", "content", "story", "entry", "post-body"]);

/**
 * Tokenizes a class/id attribute value into boundary-aware tokens: splits
 * camelCase word boundaries first (mainNav -> main-Nav), then lowercases,
 * then splits on any run of non-alphanumeric characters (hyphens,
 * underscores, whitespace between multiple class names). This is what
 * makes membership checks exact-token matches rather than naive substring
 * matches -- "navy-blue-button" tokenizes to ["navy","blue","button"],
 * none of which equals "nav", so it correctly does NOT match; "site-nav"
 * tokenizes to ["site","nav"], which correctly DOES match.
 */
function tokenizeClassOrId(value: string | null | undefined): string[] {
  if (!value) return [];
  const withCamelBoundaries = value.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  return withCamelBoundaries
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length > 0);
}

function ancestorTokens(el: HTMLElement): Set<string> {
  const tokens = new Set<string>();
  for (const tok of tokenizeClassOrId(el.getAttribute("class") ?? null)) tokens.add(tok);
  for (const tok of tokenizeClassOrId(el.getAttribute("id") ?? null)) tokens.add(tok);
  return tokens;
}

function hasAny(tokens: Set<string>, candidates: ReadonlySet<string>): boolean {
  for (const t of tokens) if (candidates.has(t)) return true;
  return false;
}

/**
 * Walks ancestors nearest-first, looking for the first one that gives a
 * confident structural signal. A single ancestor matching BOTH chrome and
 * content tokens (a genuine, if rare, class-naming collision) resolves to
 * "ambiguous" at that level rather than guessing either way -- per the
 * locked "conservative ambiguous is preferable to a false navigation/
 * citation conclusion" rule. If no ancestor within the depth bound matches
 * either, falls back to: is the nearest containing block a <p> that never
 * passed through a chrome ancestor on the way here? -> "content". Anything
 * else -> "ambiguous".
 */
function classifyPlacement(anchor: HTMLElement): LinkPlacement {
  let current: HTMLElement | null = anchor.parentNode as HTMLElement | null;
  let depth = 0;
  let sawParagraph = false;

  while (current && depth < MAX_PLACEMENT_ANCESTOR_DEPTH) {
    const tag = current.tagName ? current.tagName.toLowerCase() : "";
    if (tag === "p") sawParagraph = true;

    const isChromeTag = CHROME_ANCESTOR_TAGS.has(tag);
    const isContentTag = CONTENT_ANCESTOR_TAGS.has(tag);
    const tokens = ancestorTokens(current);
    const hasChromeToken = hasAny(tokens, CHROME_CLASS_ID_TOKENS);
    const hasContentToken = hasAny(tokens, CONTENT_CLASS_ID_TOKENS);

    const chromeMatch = isChromeTag || hasChromeToken;
    const contentMatch = isContentTag || hasContentToken;

    if (chromeMatch && contentMatch) return "ambiguous";
    if (chromeMatch) return "chrome";
    if (contentMatch) return "content";

    current = current.parentNode as HTMLElement | null;
    depth++;
  }

  // No ancestor gave a positive signal either way. Fallback positive
  // signal only (Section 5: content requires positive evidence, never
  // merely "not chrome") -- the anchor sat inside a <p> somewhere in its
  // (chrome-free, by construction of reaching this point) ancestor chain.
  return sawParagraph ? "content" : "ambiguous";
}

// ---------------------------------------------------------------------------
// Context snippet -- built from DOM SIBLING structure, not text-substring
// search. This is deliberate: a substring search for the anchor's own text
// within its parent's concatenated text breaks for an empty/image-only
// anchor (searching for "" trivially "matches" at index 0, anchoring the
// window at the wrong place) and is ambiguous when the same phrase repeats
// nearby. Walking actual preceding/following sibling nodes sidesteps both
// problems by construction -- it never depends on the anchor's own text
// content at all.
// ---------------------------------------------------------------------------

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Word-boundary truncation with a trailing ellipsis -- same algorithm/style as metadataExtraction.ts's toExcerpt(), reused here for consistency rather than a second ad hoc truncation implementation. */
function truncateWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  const ellipsis = "\u2026";
  const contentLimit = Math.max(0, maxLength - ellipsis.length);
  const truncated = value.slice(0, contentLimit);
  const lastSpace = truncated.lastIndexOf(" ");
  const safeCut = lastSpace > contentLimit * 0.6 ? truncated.slice(0, lastSpace) : truncated;

  return safeCut.trimEnd() + ellipsis;
}
function nodeText(node: Node): string {
  const el = node as HTMLElement;
  if (typeof el.text === "string") return el.text;
  const asAny = node as unknown as { rawText?: string };
  return asAny.rawText ?? "";
}

/**
 * Gathers up to `maxChars` of normalized text from `siblings[fromIndex..]`
 * (searchDirection 1) or `siblings[..fromIndex]` reversed (searchDirection
 * -1), stopping once enough characters have been collected. Returns the
 * empty string if there is nothing usable -- callers treat "" the same as
 * "no siblings in this direction", never as a found-but-empty match.
 */
function gatherSiblingText(siblings: Node[], startExclusive: number, direction: 1 | -1, maxChars: number): string {
  const collected: string[] = [];
  let collectedLength = 0;
  let i = startExclusive + direction;
  while (i >= 0 && i < siblings.length && collectedLength < maxChars) {
    const text = collapseWhitespace(nodeText(siblings[i]));
    if (text.length > 0) {
      collected.push(text);
      collectedLength += text.length + 1;
    }
    i += direction;
  }
  const ordered = direction === -1 ? collected.reverse() : collected;
  return collapseWhitespace(ordered.join(" "));
}

/**
 * Builds the bounded, whitespace-normalized context snippet for one anchor.
 * Walks up to MAX_CONTEXT_ANCESTOR_DEPTH levels looking for a container
 * whose siblings actually have non-trivial surrounding text -- an anchor
 * that is the sole child of its immediate parent (common for `<li><a>...
 * </a></li>` list-link patterns) would otherwise always yield an empty
 * snippet at the first level.
 */
function buildContextSnippet(anchor: HTMLElement, anchorText: string | null): string | null {
  let node: HTMLElement = anchor;
  let depth = 0;
  let before = "";
  let after = "";

  while (depth < MAX_CONTEXT_ANCESTOR_DEPTH) {
    const parent = node.parentNode as HTMLElement | null;
    if (!parent) break;
    const siblings = parent.childNodes as Node[];
    const idx = siblings.indexOf(node as unknown as Node);
    if (idx === -1) break;

    before = gatherSiblingText(siblings, idx, -1, CONTEXT_HALF_WINDOW_CHARS);
    after = gatherSiblingText(siblings, idx, 1, CONTEXT_HALF_WINDOW_CHARS);

    if (before.length > 0 || after.length > 0) break;
    node = parent;
    depth++;
  }

  const middle = anchorText ? collapseWhitespace(anchorText) : "";
  const assembled = collapseWhitespace([before, middle, after].filter((s) => s.length > 0).join(" "));
  if (assembled.length === 0) return null;
  return truncateWordBoundary(assembled, LINK_CONTEXT_SNIPPET_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

interface ResolvedLinkUrl {
  targetUrl: string;
  normalizedTargetUrl: string;
}

/**
 * Resolves a raw href against the fetched page's own final URL. Returns
 * null (link dropped entirely, never truncated) for: non-http(s) schemes
 * (mailto:, javascript:, tel:, etc), a target exceeding
 * TARGET_URL_MAX_LENGTH after resolution, or anything normalizeUrl()
 * itself rejects (malformed, unsupported scheme, credential-bearing --
 * reusing the EXISTING repository normalization policy verbatim, never a
 * second implementation).
 */
function resolveLinkUrl(href: string, pageUrl: string): ResolvedLinkUrl | null {
  let resolved: URL;
  try {
    resolved = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  resolved.hash = "";
  const targetUrl = resolved.toString();
  if (targetUrl.length > TARGET_URL_MAX_LENGTH) return null;

  const normalized = normalizeUrl(targetUrl);
  if (!normalized.ok) return null;
  if (normalized.normalizedUrl.length > TARGET_URL_MAX_LENGTH) return null;

  return { targetUrl, normalizedTargetUrl: normalized.normalizedUrl };
}

// ---------------------------------------------------------------------------
// Top-level extraction
// ---------------------------------------------------------------------------

const PLACEMENT_PRIORITY: Record<LinkPlacement, number> = {
  content: 0,
  ambiguous: 1,
  chrome: 2,
};

/**
 * Extracts every <a href> from `html`, resolved against `pageUrl`
 * (`fetchResult.finalUrl`), producing a bounded, deterministic
 * `LinkExtractionResult`.
 *
 * Two passes: (1) walk every anchor in document order, assigning
 * link_position and computing every field, filtering out non-http(s)/
 * over-length/normalizeUrl-rejected targets as they're found (these never
 * receive a link_position gap in the sense of being counted -- position is
 * assigned per raw <a> tag encountered, filtered candidates simply don't
 * appear in the output); (2) if more than MAX_EXTRACTED_LINKS_PER_JOB
 * candidates survived filtering, apply the priority cap: content first,
 * then ambiguous, then chrome, with link_position ascending as the stable
 * tiebreaker within each tier. This ordering exists specifically so a
 * nav-heavy page (nav is almost always earliest in the DOM) doesn't
 * systematically crowd out later, genuine in-article content links purely
 * because of document order.
 */
export function extractLinks(html: string, pageUrl: string): LinkExtractionResult {
  const root = parse(html, { comment: false });
  const anchors = root.querySelectorAll("a");
  const pageHostname = extractHostname(pageUrl);

  const candidates: ExtractedLink[] = [];
  let linkPosition = 0;

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    const position = linkPosition;
    linkPosition++;

    if (!href) continue;
    const resolved = resolveLinkUrl(href, pageUrl);
    if (!resolved) continue;

    const rawAnchorText = collapseWhitespace(anchor.text ?? "");
    const anchorText = rawAnchorText.length > 0 ? truncateWordBoundary(rawAnchorText, ANCHOR_TEXT_MAX_LENGTH) : null;
    const contextSnippet = buildContextSnippet(anchor, rawAnchorText.length > 0 ? rawAnchorText : null);

    const rawRel = anchor.getAttribute("rel");
    const relAttribute = rawRel ? truncateWordBoundary(rawRel.trim(), REL_ATTRIBUTE_MAX_LENGTH) || null : null;

    const targetHostname = extractHostname(resolved.targetUrl);
    const isSameSite = Boolean(pageHostname && targetHostname && pageHostname === targetHostname);

    candidates.push({
      linkPosition: position,
      targetUrl: resolved.targetUrl,
      normalizedTargetUrl: resolved.normalizedTargetUrl,
      anchorText,
      contextSnippet,
      relAttribute,
      placement: classifyPlacement(anchor),
      isSameSite,
    });
  }

  // Priority-select which candidates survive the cap (content -> ambiguous
  // -> chrome, link_position ascending as tiebreaker), then restore
  // original document order for the surviving set -- the cap decides
  // WHICH links are kept, not what order downstream consumers (staging
  // JSON, the admin UI, this PR's own priority-cap check) see them in.
  const kept = [...candidates]
    .sort((a, b) => {
      const priorityDiff = PLACEMENT_PRIORITY[a.placement] - PLACEMENT_PRIORITY[b.placement];
      if (priorityDiff !== 0) return priorityDiff;
      return a.linkPosition - b.linkPosition;
    })
    .slice(0, MAX_EXTRACTED_LINKS_PER_JOB);
  const capped = kept.sort((a, b) => a.linkPosition - b.linkPosition);

  return {
    links: capped,
    totalAnchorsEncountered: anchors.length,
  };
}
