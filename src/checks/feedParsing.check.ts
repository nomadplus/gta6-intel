/**
 * Regression check for Phase 4 PR 10's feed-parsing adapter
 * (src/lib/ingestion/feedParsing.ts) and its bounded entity decoder
 * (src/lib/ingestion/xmlEntityDecode.ts).
 *
 * Pure, no database needed -- exercises the real parseFeed() and
 * decodeBoundedXmlEntities() functions directly against small,
 * hand-written RSS 2.0 / Atom sample documents and adversarial
 * entity/DOCTYPE input.
 *
 * Run with: npx tsx src/checks/feedParsing.check.ts
 */
import { parseFeed, MAX_ITEMS_PER_FEED } from "../lib/ingestion/feedParsing";
import { decodeBoundedXmlEntities, MAX_INPUT_LENGTH } from "../lib/ingestion/xmlEntityDecode";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log("=== RSS/Atom feed parsing + bounded entity decoding ===\n");

// ---------------------------------------------------------------------------
// RSS 2.0 item URL extraction
// ---------------------------------------------------------------------------
{
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Item 1</title>
      <link>https://example.test/article-1?a=1&amp;b=2</link>
    </item>
    <item>
      <title>Item 2 -- malformed, no link</title>
    </item>
    <item>
      <title>Item 3</title>
      <link>https://example.test/article-3</link>
    </item>
  </channel>
</rss>`;

  const result = parseFeed(rssXml);
  assert(result.ok === true, "RSS 2.0 document parses successfully");
  if (result.ok) {
    assert(result.format === "rss", "RSS 2.0 document is detected as format 'rss'");
    assert(result.totalEntriesFound === 3, `RSS 2.0 document reports 3 total <item> entries found (got ${result.totalEntriesFound})`);
    assert(
      result.items.length === 2,
      `the malformed (no-link) item is skipped without failing the feed -- 2 usable items extracted (got ${result.items.length})`
    );
    assert(
      result.items[0]?.rawUrl === "https://example.test/article-1?a=1&b=2",
      `first RSS item URL is extracted with &amp; correctly decoded to & (got "${result.items[0]?.rawUrl}")`
    );
    assert(
      result.items[1]?.rawUrl === "https://example.test/article-3",
      `second usable RSS item URL is extracted correctly (got "${result.items[1]?.rawUrl}")`
    );
  }
}

// ---------------------------------------------------------------------------
// Atom link selection: rel="alternate" first, then no-rel, ignoring self/enclosure
// ---------------------------------------------------------------------------
{
  const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <entry>
    <title>Entry with self AND alternate -- alternate must win</title>
    <link rel="self" href="https://example.test/self-1"/>
    <link rel="alternate" href="https://example.test/entry-1"/>
  </entry>
  <entry>
    <title>Entry with only a self link -- no alternate, no no-rel link -- must be skipped</title>
    <link rel="self" href="https://example.test/self-2"/>
    <link rel="enclosure" href="https://example.test/enclosure-2.mp3"/>
  </entry>
  <entry>
    <title>Entry with a rel-less link only -- falls back to it</title>
    <link href="https://example.test/entry-3"/>
  </entry>
  <entry>
    <title>Entry with no link at all -- malformed, must be skipped</title>
  </entry>
</feed>`;

  const result = parseFeed(atomXml);
  assert(result.ok === true, "Atom document parses successfully");
  if (result.ok) {
    assert(result.format === "atom", "Atom document is detected as format 'atom'");
    assert(result.totalEntriesFound === 4, `Atom document reports 4 total <entry> elements found (got ${result.totalEntriesFound})`);
    assert(
      result.items.length === 2,
      `entries with only self/enclosure links or no link at all are skipped -- 2 usable items extracted (got ${result.items.length})`
    );
    assert(
      result.items[0]?.rawUrl === "https://example.test/entry-1",
      `rel="alternate" is preferred over rel="self" on the same entry (got "${result.items[0]?.rawUrl}")`
    );
    assert(
      result.items[1]?.rawUrl === "https://example.test/entry-3",
      `a rel-less link is used as a fallback when no alternate exists (got "${result.items[1]?.rawUrl}")`
    );
  }
}

// ---------------------------------------------------------------------------
// DOCTYPE rejection -- BEFORE parsing, regardless of what the DOCTYPE contains
// ---------------------------------------------------------------------------
{
  const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe "billion laughs attempt">]>
<rss version="2.0"><channel><item><link>https://example.test/x</link></item></channel></rss>`;

  const result = parseFeed(maliciousXml);
  assert(result.ok === false, "a feed document containing a DOCTYPE declaration is rejected, not parsed");
  if (!result.ok) {
    assert(
      result.error.code === "doctype_rejected",
      `rejection is specifically coded 'doctype_rejected' (got "${result.error.code}")`
    );
  }
}

{
  // Case-insensitivity and a DOCTYPE appearing after otherwise-valid content.
  const lowercaseDoctype = `<rss version="2.0"><channel><!doctype foo><item><link>https://example.test/x</link></item></channel></rss>`;
  const result = parseFeed(lowercaseDoctype);
  assert(result.ok === false && result.error.code === "doctype_rejected", "DOCTYPE rejection is case-insensitive and position-independent");
}

// ---------------------------------------------------------------------------
// Malformed documents don't throw -- they return a typed error result
// ---------------------------------------------------------------------------
{
  const notXmlAtAll = "this is not xml at all <<< &&&";
  let threw = false;
  let result;
  try {
    result = parseFeed(notXmlAtAll);
  } catch {
    threw = true;
  }
  assert(!threw, "parseFeed never throws, even on completely invalid input");
  assert(result !== undefined && result.ok === false, "completely invalid input is reported as a typed failure, not a crash");
}

{
  const wrongRoot = `<?xml version="1.0"?><somethingElse><item><link>https://example.test/x</link></item></somethingElse>`;
  const result = parseFeed(wrongRoot);
  assert(result.ok === false, "a document that is valid XML but neither <rss> nor <feed> is rejected");
  if (!result.ok) {
    assert(result.error.code === "unrecognized_format", `rejection is coded 'unrecognized_format' (got "${result.error.code}")`);
  }
}

// ---------------------------------------------------------------------------
// Item cap -- MAX_ITEMS_PER_FEED bounds a single feed's contribution
// ---------------------------------------------------------------------------
{
  const manyItems = Array.from(
    { length: MAX_ITEMS_PER_FEED + 20 },
    (_, i) => `<item><link>https://example.test/item-${i}</link></item>`
  ).join("");
  const bigFeed = `<rss version="2.0"><channel>${manyItems}</channel></rss>`;
  const result = parseFeed(bigFeed);
  assert(result.ok === true, "an oversized feed still parses successfully");
  if (result.ok) {
    assert(
      result.totalEntriesFound === MAX_ITEMS_PER_FEED + 20,
      `totalEntriesFound reports the true count before capping (got ${result.totalEntriesFound})`
    );
    assert(
      result.items.length === MAX_ITEMS_PER_FEED,
      `items are capped at MAX_ITEMS_PER_FEED=${MAX_ITEMS_PER_FEED} regardless of how many the feed actually contains (got ${result.items.length})`
    );
  }
}

// ---------------------------------------------------------------------------
// Bounded XML entity decoding (xmlEntityDecode.ts)
// ---------------------------------------------------------------------------
assert(
  decodeBoundedXmlEntities("https://example.test/a?x=1&amp;y=2") === "https://example.test/a?x=1&y=2",
  "&amp; decodes to & in an extracted URL"
);
assert(decodeBoundedXmlEntities("&lt;script&gt;") === "<script>", "&lt;/&gt; decode to </>");
assert(decodeBoundedXmlEntities("&quot;&apos;") === `"'`, "&quot;/&apos; decode to \"/'");
assert(decodeBoundedXmlEntities("&#65;&#66;&#67;") === "ABC", "decimal numeric character references decode correctly");
assert(decodeBoundedXmlEntities("&#x41;&#x42;") === "AB", "hexadecimal numeric character references decode correctly");
assert(
  decodeBoundedXmlEntities("&unknownEntity;") === "&unknownEntity;",
  "an unknown named entity (e.g. a DOCTYPE-defined custom one) is left exactly as-is, never guessed at"
);

{
  // Out-of-range code point -- this is the exact failure mode behind
  // fast-xml-parser's CVE-2026-25128 (a RangeError that crashed the
  // whole parse). This decoder must catch it per-reference instead.
  let threw = false;
  let output = "";
  try {
    output = decodeBoundedXmlEntities("&#99999999999;end");
  } catch {
    threw = true;
  }
  assert(!threw, "an out-of-range numeric character reference does not throw");
  assert(output === "&#99999999999;end", "an out-of-range numeric character reference is left undecoded rather than crashing the decode");
}

{
  // Input length hard cap, independent of anything upstream.
  const oversized = "a".repeat(MAX_INPUT_LENGTH * 2);
  const decoded = decodeBoundedXmlEntities(oversized);
  assert(
    decoded.length === MAX_INPUT_LENGTH,
    `input longer than MAX_INPUT_LENGTH=${MAX_INPUT_LENGTH} is truncated before any processing (got length ${decoded.length})`
  );
}

if (failures > 0) {
  console.error(`\n${failures} feed parsing check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll feed parsing checks passed.");
}
