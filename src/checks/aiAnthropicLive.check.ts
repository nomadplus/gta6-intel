/**
 * Phase 5 PR 1 -- OPTIONAL live smoke test against the REAL Anthropic
 * API. Deliberately NOT part of `npm run check`: it costs real tokens,
 * requires network access and a real ANTHROPIC_API_KEY, and is not
 * deterministic in the way the standard check suite must be (see
 * aiRunOperation.check.ts's header for why that suite stays
 * fake-provider-only).
 *
 * Run explicitly and only when you want to confirm AnthropicProvider's
 * actual wire integration (tool-use structured output, real token
 * accounting) still works against the live API:
 *
 *   ANTHROPIC_API_KEY=sk-... AI_LIVE_TEST_OPT_IN=yes \
 *     npx tsx --conditions=react-server src/checks/aiAnthropicLive.check.ts
 *
 * Both ANTHROPIC_API_KEY and the explicit AI_LIVE_TEST_OPT_IN=yes flag
 * are required -- the presence of an API key alone is not treated as
 * consent to spend it. This never runs in CI and must never be added to
 * the `check` npm script.
 */
import { z } from "zod";
import { getAnthropicProvider } from "../lib/ai/providers/anthropicProvider";

async function main() {
  if (process.env.AI_LIVE_TEST_OPT_IN !== "yes") {
    throw new Error(
      "Refusing to run: this check makes a real, billed Anthropic API call. " +
        "Set AI_LIVE_TEST_OPT_IN=yes explicitly to opt in (see this file's header comment)."
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set -- required for this live smoke test.");
  }
  if (!process.env.AI_DEFAULT_MODEL) {
    throw new Error("AI_DEFAULT_MODEL is not set.");
  }

  console.log("=== LIVE Anthropic smoke test -- this call is real and billed ===\n");

  const schema = z.object({
    isPangram: z.boolean(),
    reasoning: z.string(),
  });

  const provider = getAnthropicProvider();
  const result = await provider.complete({
    operation: "classify_relevance",
    model: process.env.AI_DEFAULT_MODEL,
    systemPrompt: "You determine whether a sentence is a pangram (uses every letter of the English alphabet at least once).",
    userPrompt: 'Is this a pangram? "The quick brown fox jumps over the lazy dog."',
    outputSchema: schema,
    inputRef: "live-smoke-test",
  });

  if (!result.ok) {
    console.error(`FAIL: live call did not succeed -- reason=${result.reason} message=${result.message}`);
    process.exit(1);
  }

  console.log(`Structured output: ${JSON.stringify(result.data)}`);
  console.log(`Tokens: in=${result.tokensIn} out=${result.tokensOut}`);

  if (result.data.isPangram !== true) {
    console.error("FAIL: expected the model to correctly identify a well-known pangram.");
    process.exit(1);
  }

  console.log("\nLive Anthropic smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
