/**
 * Deterministic RSS 2.0 / Atom parsing, narrowed to exactly one thing:
 * extracting each item/entry's article URL. Nothing else — no title,
 * author, published date, or description extraction here. That
 * metadata is PR 4's job (metadataExtraction.ts), applied later against
 * the actual fetched article page, not the feed. Duplicating it here
 * would mean maintaining two divergent extraction paths for the same
 * fields; this module's only concern is getting a URL into the
 * pipeline.
 *
 * Pure, no I/O — takes an already-fetched feed body (via safeFetch) and
 * returns a plain result. No network access, no database access.
 *
 * ---------------------------------------------------------------------
 * Security posture (fast-xml-parser)
 *
 * fast-xml-parser has a real history of DOCTYPE/entity-related
 * vulnerabilities: unlimited entity expansion (CVE-2026-26278, fixed
 * 5.3.6), a bypass of that fix via numeric character references
 * (CVE-2026-33036, fixed 5.5.6), a truthy-check bug that silently
 * disabled the maxEntityCount/maxEntitySize limits when set to 0
 * (CVE-2026-33349, fixed 5.5.7), an entity-encoding regex-injection
 * bypass (CVE-2026-25896, fixed 5.3.5), a RangeError crash on
 * out-of-range numeric entities (CVE-2026-25128, fixed 5.3.4), and most
 * recently a repeated-DOCTYPE bypass of the expansion counters
 * themselves (GHSA-8r6m-32jq-jx6q, fixed 5.10.1). Every one of these
 * lives in the DOCTYPE/entity-substitution code path — none affect
 * ordinary element/attribute parsing.
 *
 * This module is pinned to fast-xml-parser 5.11.0 (current latest as of
 * this PR, verified against the advisory list above — re-verify at any
 * future upgrade), and defends in depth rather than relying on the pin
 * alone:
 *
 *   1. Any feed body containing a `<!DOCTYPE` declaration is rejected
 *      OUTRIGHT, before the parser ever sees it. Legitimate RSS/Atom
 *      feeds never declare one — this closes the entire vulnerability
 *      class at the door, independent of which version is installed or
 *      what future bypass might be found in that code path.
 *   2. `processEntities: false` disables DOCTYPE-driven and numeric-
 *      character-reference entity substitution entirely — the exact
 *      mitigation named in every advisory above. Combined with (1), the
 *      vulnerable code path is never exercised at all.
 *   3. Because that leaves entities like `&amp;` un-decoded in extracted
 *      text, and a real article URL can legitimately contain `&amp;` in
 *      its query string, a small dedicated decoder
 *      (xmlEntityDecode.ts) — NOT fast-xml-parser's own entity
 *      handling — is applied to each extracted URL string, which is
 *      short and bounded by construction (see that file's header).
 * ---------------------------------------------------------------------
 */
import { XMLParser, type MatcherView } from "fast-xml-parser";
import { decodeBoundedXmlEntities } from "./xmlEntityDecode";

/** Defensive bound on how many items one feed's poll will consider — see this file's header on why old items beyond this are simply left for a future normal encounter rather than treated as an error. */
export const MAX_ITEMS_PER_FEED = 50;

const DOCTYPE_PATTERN = /<!DOCTYPE/i;

const feedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Security posture -- see file header. Disables DOCTYPE/custom-entity
  // and numeric-character-reference substitution entirely; this
  // pipeline never needs it, since we only ever read plain element text
  // and href attributes.
  processEntities: false,
  trimValues: true,
  cdataPropName: "#cdata",
  // Callbacks receive jPath as a plain string (backward-compatible mode)
  // rather than a MatcherView, matching the isArray callback below.
  jPath: true,
  // Force these three paths to always be arrays, regardless of how many
  // elements are actually present -- removes "is this one item or many"
  // branching from the extraction code below. jPath strings are the
  // dot-joined tag path from the document root, per fast-xml-parser's
  // documented isArray contract.
  isArray: (_name: string, jPathOrMatcher: string | MatcherView) => {
    const jPath = typeof jPathOrMatcher === "string" ? jPathOrMatcher : jPathOrMatcher.toString();
    return jPath === "rss.channel.item" || jPath === "feed.entry" || jPath === "feed.entry.link";
  },
});

export type FeedFormat = "rss" | "atom";

export interface ParsedFeedItem {
  /** The article URL exactly as extracted from the feed (entity-decoded, NOT yet run through normalizeUrl() -- that's the caller's job, same as any other submitted URL). */
  rawUrl: string;
}

export type FeedParseErrorCode = "doctype_rejected" | "unrecognized_format" | "malformed_xml";

export interface FeedParseError {
  code: FeedParseErrorCode;
  message: string;
}

export type ParseFeedResult =
  | { ok: true; format: FeedFormat; items: ParsedFeedItem[]; totalEntriesFound: number }
  | { ok: false; error: FeedParseError };

/**
 * CDATA-aware text extraction: fast-xml-parser exposes CDATA content
 * under the configured `cdataPropName` key rather than as the node's
 * plain value when a CDATA section is present. This handles both shapes
 * so a `<link>` wrapped in CDATA (uncommon but valid) still yields its
 * text.
 */
function textOf(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node && typeof node === "object" && "#cdata" in node) {
    const cdata = (node as Record<string, unknown>)["#cdata"];
    return typeof cdata === "string" ? cdata : null;
  }
  return null;
}

function extractRssItems(channel: Record<string, unknown>): ParsedFeedItem[] {
  const rawItems = channel.item;
  if (!Array.isArray(rawItems)) return [];

  const items: ParsedFeedItem[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const linkText = textOf((item as Record<string, unknown>).link);
    if (!linkText) continue; // malformed item (no link) -- skip, don't fail the whole feed
    items.push({ rawUrl: decodeBoundedXmlEntities(linkText.trim()) });
  }
  return items;
}

/**
 * Atom link selection (locked decision): prefer a link with
 * rel="alternate"; if none, fall back to a link with no rel attribute
 * at all (Atom's own spec default). Links with any other rel (self,
 * enclosure, related, etc.) are never selected as the item's article
 * URL.
 */
function selectAtomEntryUrl(entry: Record<string, unknown>): string | null {
  const rawLinks = entry.link;
  const links: unknown[] = Array.isArray(rawLinks) ? rawLinks : rawLinks != null ? [rawLinks] : [];

  const hrefOf = (link: unknown): string | null => {
    if (typeof link === "string") return link;
    if (link && typeof link === "object") {
      const href = (link as Record<string, unknown>)["@_href"];
      return typeof href === "string" ? href : null;
    }
    return null;
  };
  const relOf = (link: unknown): string | undefined => {
    if (link && typeof link === "object") {
      const rel = (link as Record<string, unknown>)["@_rel"];
      return typeof rel === "string" ? rel : undefined;
    }
    return undefined;
  };

  const alternate = links.find((l) => relOf(l) === "alternate");
  if (alternate) return hrefOf(alternate);

  const noRel = links.find((l) => relOf(l) === undefined);
  if (noRel) return hrefOf(noRel);

  return null;
}

function extractAtomEntries(feed: Record<string, unknown>): ParsedFeedItem[] {
  const rawEntries = feed.entry;
  if (!Array.isArray(rawEntries)) return [];

  const items: ParsedFeedItem[] = [];
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== "object") continue;
    const href = selectAtomEntryUrl(entry as Record<string, unknown>);
    if (!href) continue; // no alternate/no-rel link found -- skip, don't fail the whole feed
    items.push({ rawUrl: decodeBoundedXmlEntities(href.trim()) });
  }
  return items;
}

/**
 * Parses a fetched feed body into a bounded list of candidate item
 * URLs. Never throws — parser/format/DOCTYPE failures are returned as a
 * typed error result, matching this codebase's established
 * result-object convention (safeFetch, normalizeUrl) rather than
 * exceptions for expected failure modes.
 */
export function parseFeed(xmlText: string): ParseFeedResult {
  if (DOCTYPE_PATTERN.test(xmlText)) {
    return {
      ok: false,
      error: {
        code: "doctype_rejected",
        message: "Feed document contains a DOCTYPE declaration, which is never expected in a legitimate RSS/Atom feed.",
      },
    };
  }

  let doc: unknown;
  try {
    doc = feedXmlParser.parse(xmlText);
  } catch {
    return { ok: false, error: { code: "malformed_xml", message: "Feed document could not be parsed as XML." } };
  }

  const root = doc as Record<string, unknown> | null;

  const rss = root?.rss as Record<string, unknown> | undefined;
  if (rss?.channel && typeof rss.channel === "object") {
    const channel = rss.channel as Record<string, unknown>;
    const items = extractRssItems(channel);
    const totalEntriesFound = Array.isArray(channel.item) ? channel.item.length : 0;
    return { ok: true, format: "rss", items: items.slice(0, MAX_ITEMS_PER_FEED), totalEntriesFound };
  }

  const feed = root?.feed as Record<string, unknown> | undefined;
  if (feed && typeof feed === "object") {
    const items = extractAtomEntries(feed);
    const totalEntriesFound = Array.isArray(feed.entry) ? feed.entry.length : 0;
    return { ok: true, format: "atom", items: items.slice(0, MAX_ITEMS_PER_FEED), totalEntriesFound };
  }

  return {
    ok: false,
    error: { code: "unrecognized_format", message: "Document root was neither <rss> nor <feed> (Atom)." },
  };
}
