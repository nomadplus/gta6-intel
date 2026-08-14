/**
 * Source identity proposal (Section 10 of the PR spec). Pure matching
 * logic only -- the caller queries `sources` for candidate rows (a
 * cheap `SELECT id, homepage_url FROM sources` easily fits in memory at
 * this project's current scale) and passes them in here; this module
 * never touches the database.
 *
 * Deliberately narrow: a hostname match is a proposal for the admin to
 * confirm, never an automatic `sources` row creation (Section 10:
 * "Do not silently create a `sources` row"), and it carries no signal
 * about trustworthiness (Section 11) -- it only answers "does this
 * fetched item's hostname match a source we already know about."
 */

export interface CandidateSource {
  id: number;
  homepageUrl: string | null;
}

export type SourceIdentityProposal =
  | { kind: "proposed"; sourceId: number }
  | { kind: "no_match" }
  | { kind: "ambiguous"; matchedSourceIds: number[] };

/**
 * Extracts a comparable hostname from a URL string, or `null` if the
 * value isn't a syntactically valid absolute URL (a source with a
 * malformed/missing `homepage_url` simply can't participate in
 * matching -- it's excluded, not treated as an error).
 *
 * Deliberately exact-hostname matching, with NO "www." stripping or
 * other fuzzy normalization -- kept consistent with `normalizeUrl()`
 * in urlNormalization.ts, which makes the same deliberate choice for
 * the same reason (see that file's header). This is a known, accepted
 * limitation: a source whose `homepage_url` is
 * "https://www.example.com" will NOT match a fetched item from
 * "https://example.com/article", and vice versa -- that case falls
 * through to `no_match` (never a false-positive "ambiguous" or a wrong
 * single match), which is the safe direction to fail in given Section
 * 10's "do not infer" instruction. If this proves too strict in
 * practice, loosening it is a deliberate future decision, not something
 * to fold in silently here.
 */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Proposes a `sources` row for a freshly-fetched item's hostname
 * (derived from its `finalUrl`/`canonicalUrl`, per the caller's
 * choice -- this function only compares whatever hostname it's given
 * against each candidate's homepage hostname).
 *
 * - Exactly one candidate's homepage hostname matches -> `proposed`.
 * - Zero matches -> `no_match` (Section 10: admin creates/reviews a
 *   source manually; this pipeline creates nothing).
 * - Two or more distinct sources share that hostname -> `ambiguous`
 *   (the data itself is ambiguous; guessing which one is wrong,
 *   regardless of how the tie is broken).
 */
export function proposeSourceIdentity(
  fetchedHostname: string,
  candidates: readonly CandidateSource[]
): SourceIdentityProposal {
  const matches = candidates.filter((candidate) => {
    if (!candidate.homepageUrl) return false;
    return extractHostname(candidate.homepageUrl) === fetchedHostname;
  });

  if (matches.length === 0) return { kind: "no_match" };
  if (matches.length === 1) return { kind: "proposed", sourceId: matches[0]!.id };
  return { kind: "ambiguous", matchedSourceIds: matches.map((m) => m.id).sort((a, b) => a - b) };
}
