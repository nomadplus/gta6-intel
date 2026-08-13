/**
 * Regression check for the two-axis status display.
 *
 * This is not a UI snapshot test -- it exercises the same pure function
 * the components call (statusDisplay.ts) plus a real render of StatusPair
 * via React's server-side renderToStaticMarkup, so it catches both:
 *   1. a future edit that merges the two axes back into one label/badge
 *   2. a future edit that breaks the "Confirmed" + "Cut" combination
 *      specifically (the case Phase 1/2 were built to prove out)
 *
 * Run with: npx tsx src/checks/statusPresentation.check.ts
 */
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { StatusPair } from "../components/status/StatusPair";
import {
  investigationStatusDisplay,
  developmentOutcomeDisplay,
} from "../lib/statusDisplay";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// --- 1. Pure mapping check: the two axes must never share a label space ---
const investigationLabels = new Set(Object.values(investigationStatusDisplay).map((d) => d.label));
const outcomeLabels = new Set(Object.values(developmentOutcomeDisplay).map((d) => d.label));
const overlap = [...investigationLabels].filter((l) => outcomeLabels.has(l));
assert(
  overlap.length === 0,
  `investigation and development-outcome labels are disjoint (found overlap: ${overlap.join(", ") || "none"})`
);

// --- 2. Render check: the exact divergent case (Confirmed + Cut) ---
const html = renderToStaticMarkup(
  React.createElement(StatusPair, {
    investigationStatus: "confirmed",
    developmentOutcome: "cut",
  })
);

assert(html.includes("Confirmed"), "rendered output contains the Investigation label 'Confirmed'");
assert(html.includes("Cut"), "rendered output contains the Development Outcome label 'Cut'");
assert(
  html.includes("Investigation") && html.includes("Outcome"),
  "rendered output contains both axis eyebrow labels ('Investigation' and 'Outcome')"
);

// The two values must appear in two SEPARATE stamp elements, not one
// merged badge. We check this structurally: count distinct bordered
// stamp blocks, expect exactly 2.
const stampCount = (html.match(/font-mono text-\[10px\] uppercase tracking-\[0\.18em\]/g) ?? []).length;
assert(stampCount === 2, `exactly two distinct stamp elements are rendered (found ${stampCount})`);

// Confirm neither value's markup contains the other's tone class --
// guards against a future edit that recolors both axes identically,
// which would defeat the "visually distinct" requirement even if the
// text labels stayed correct.
const confirmedToneMatch = html.match(/border-signal-confirmed\/50 text-signal-confirmed">\s*<div[^>]*>Investigation/);
const cutToneMatch = html.match(/border-signal-disproven\/50 text-signal-disproven">\s*<div[^>]*>Outcome/);
assert(
  confirmedToneMatch !== null,
  "Investigation stamp uses the 'positive' tone class distinct from Outcome"
);
assert(
  cutToneMatch !== null,
  "Outcome stamp (Cut) uses the 'negative' tone class distinct from Investigation"
);

if (process.exitCode === 1) {
  console.error("\nOne or more status-presentation regression checks FAILED.");
} else {
  console.log("\nAll status-presentation regression checks passed.");
}
