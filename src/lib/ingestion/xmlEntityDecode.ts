/**
 * A small, self-contained decoder for the five predefined XML entities
 * and standard numeric character references, applied ONLY to an
 * already-extracted item URL string (a few dozen to a few hundred
 * bytes) — never to a raw feed document.
 *
 * Why this exists instead of using fast-xml-parser's own entity
 * handling: that library has a real history of DOCTYPE/entity-expansion
 * vulnerabilities (CVE-2026-26278, CVE-2026-33036, CVE-2026-33349,
 * CVE-2026-25896, GHSA-8r6m-32jq-jx6q — see feedParsing.ts's file header
 * for the full list and fix versions). This project's PR 10 parser
 * config sets `processEntities: false`, which disables that entire
 * code path — deliberately never exercised, regardless of which
 * version of the library is installed. But `processEntities: false`
 * also means the parser leaves entities like `&amp;` literally
 * un-decoded in extracted text, and a real article URL can legitimately
 * contain `&amp;` in its query string (e.g. `?a=1&amp;b=2`) — so
 * something still needs to decode that, correctly and safely.
 *
 * This decoder is that something. It is NOT a general XML/HTML entity
 * processor — it only exists to make the one specific string this
 * pipeline extracts (an item URL) round-trip correctly. It is bounded
 * by construction:
 *
 *   - It operates on a single already-short string (the URL), never the
 *     feed document itself — there is no recursive/self-referential
 *     expansion possible on a plain string.
 *   - Every replacement is a single input entity mapped to a single
 *     output character/short sequence — nothing here expands one
 *     matched span into a larger one relative to its own output, so
 *     there is no amplification factor to exploit even in principle.
 *   - Input length is hard-capped (MAX_INPUT_LENGTH) before any
 *     processing happens, independent of anything the caller does.
 *   - Numeric character references are resolved via
 *     `String.fromCodePoint`, which throws on an out-of-range code
 *     point (the exact failure mode behind CVE-2026-25128) — that throw
 *     is caught per-reference and the reference is left undecoded
 *     rather than crashing the whole decode.
 */

/** Defensive cap, independent of anything upstream — a normalized URL has no legitimate reason to exceed this. */
export const MAX_INPUT_LENGTH = 4096;

const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

// Matches exactly: &name; (predefined), &#123; (decimal), &#x1F; (hex).
// Deliberately anchored to a short, fixed entity-name alphabet -- not
// DOCTYPE-aware, not recursive, and matches at most one entity per span
// (no nested/overlapping matches possible with this pattern).
const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

/**
 * Decodes the five predefined XML entities and standard numeric
 * character references in `input`. Any entity-shaped span that isn't
 * one of those (an unknown named entity, e.g. a DOCTYPE-defined custom
 * one) is left exactly as-is in the output — this function never
 * consults or requires a DOCTYPE, and never expands anything beyond a
 * single literal substitution per match.
 */
export function decodeBoundedXmlEntities(input: string): string {
  const truncated = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input;

  return truncated.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const numericPart = isHex ? body.slice(2) : body.slice(1);
      const codePoint = parseInt(numericPart, isHex ? 16 : 10);
      if (!Number.isFinite(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        // Out-of-range code point (CVE-2026-25128's failure mode in
        // fast-xml-parser) -- leave the original reference undecoded
        // rather than throwing.
        return match;
      }
    }

    const predefined = PREDEFINED_ENTITIES.get(body);
    return predefined ?? match;
  });
}
