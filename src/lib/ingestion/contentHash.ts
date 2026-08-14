/**
 * Deterministic content hashing for ingestion.
 *
 * This is the one piece of "is this the same content we already have"
 * logic that is conventional and cheap enough to never need AI (see
 * Section 10 of the project instructions) -- a straight cryptographic
 * hash, computed once per successful fetch and stored on both
 * `ingestion_jobs`-derived candidates and `source_items.raw_content_hash`.
 *
 * What exactly gets hashed, precisely:
 *
 *   sha256(utf8Bytes(bodyText))
 *
 * where `bodyText` is the *already-decoded* string `safeFetch()` returns
 * (see safeFetch.ts's `readBodyWithCap`, which always decodes the raw
 * response bytes via `TextDecoder("utf-8")`, regardless of the page's
 * actual declared charset). This module does not re-fetch or re-read raw
 * bytes off the wire -- it hashes Node's UTF-8 re-encoding of that
 * decoded string, via `Buffer`'s default `"utf8"` handling in
 * `crypto.Hash.update`.
 *
 * Two real consequences of that choice, both accepted deliberately
 * rather than silently:
 *
 *   1. A page served in a non-UTF-8 encoding (e.g. legacy Shift-JIS or
 *      Windows-1252) will decode to a *different* string than the
 *      original bytes represented if TextDecoder mis-detects it -- this
 *      hash is therefore a hash of "the content as this pipeline saw
 *      it", not a bit-for-bit hash of what the origin server sent. This
 *      is consistent with the pipeline's excerpt/metadata extraction,
 *      which reads from the same decoded string, so a legacy-encoding
 *      page is internally consistent (a fetch, its excerpt, and its hash
 *      all agree with each other) even if not byte-identical to the
 *      wire.
 *   2. Because the hash is computed on the same string handed to
 *      metadata extraction, no separate raw-byte buffer needs to be
 *      retained past the request -- reinforcing Section 6 (no full
 *      article body is ever persisted; only this 64-character digest
 *      is).
 *
 * Uses Node's built-in `node:crypto` -- no new dependency needed for a
 * single hash call.
 */
import { createHash } from "node:crypto";

/**
 * Computes the deterministic `raw_content_hash` value for a fetched
 * source item: lowercase hex-encoded SHA-256 of the UTF-8 bytes of
 * `bodyText`, matching the `varchar(64)` column width exactly (SHA-256
 * hex digests are always 64 characters).
 */
export function computeRawContentHash(bodyText: string): string {
  return createHash("sha256").update(bodyText, "utf8").digest("hex");
}
