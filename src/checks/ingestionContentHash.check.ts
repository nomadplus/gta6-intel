/**
 * Regression check for src/lib/ingestion/contentHash.ts.
 *
 * Run with: npx tsx src/checks/ingestionContentHash.check.ts
 */
import { createHash } from "node:crypto";
import { computeRawContentHash } from "../lib/ingestion/contentHash";

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// --- Determinism ------------------------------------------------------
{
  const a = computeRawContentHash("<html><body>Hello world</body></html>");
  const b = computeRawContentHash("<html><body>Hello world</body></html>");
  assert(a === b, "identical input produces identical hash");
}

// --- Sensitivity --------------------------------------------------------
{
  const a = computeRawContentHash("<html><body>Hello world</body></html>");
  const b = computeRawContentHash("<html><body>Hello World</body></html>"); // single char case difference
  assert(a !== b, "a single-character difference changes the hash");
}

// --- Matches manual sha256 hex of utf8 bytes -----------------------------
{
  const body = "The quick brown fox jumps over the lazy dog — 日本語";
  const expected = createHash("sha256").update(body, "utf8").digest("hex");
  assert(computeRawContentHash(body) === expected, "matches a manually computed sha256 hex digest of the UTF-8 bytes");
}

// --- Shape ----------------------------------------------------------------
{
  const hash = computeRawContentHash("anything");
  assert(hash.length === 64, `hash is 64 hex characters (varchar(64) column width) -- got ${hash.length}`);
  assert(/^[a-f0-9]{64}$/.test(hash), "hash is lowercase hex only");
}

// --- Empty body -------------------------------------------------------
{
  const hash = computeRawContentHash("");
  assert(hash.length === 64, "an empty body still produces a well-formed 64-char digest");
}

if (failures > 0) {
  console.error(`\n${failures} content hash check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log("\nAll content hash checks passed.");
}
