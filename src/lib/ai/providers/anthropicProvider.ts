import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getAnthropicApiKey } from "../config";
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "../types";

/**
 * Phase 5 PR 1: the only real (non-fake) AiProvider implementation.
 * Deliberately the single provider introduced in this PR (per the
 * approved plan's "no abstraction theatre" instruction) -- Anthropic is
 * the model already doing this project's analysis today. Adding a
 * second real provider with nothing yet to exercise it would just be
 * unused surface area; the AiProvider interface itself (types.ts) is
 * what makes adding one later straightforward, not a second
 * implementation sitting here unused.
 *
 * Structured output: uses a single forced tool call (tool_choice
 * {type:"tool", name:"emit_result"}) whose input_schema is the caller's
 * Zod outputSchema converted via Zod 4's native z.toJSONSchema() -- no
 * extra dependency needed for that conversion. This is deliberately NOT
 * "ask the model to write JSON in prose and regex/parse it" -- forcing a
 * single tool call is Anthropic's supported mechanism for reliably
 * shaped output, and complete() still re-validates the tool call's
 * input against the same Zod schema before returning it (never a blind
 * cast of whatever the model claims to have produced).
 */

const ANTHROPIC_RESULT_TOOL_NAME = "emit_result";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const jsonSchema = z.toJSONSchema(request.outputSchema, { target: "draft-2020-12" });

    let response;
    try {
      response = await this.client.messages.create({
        model: request.model,
        // Phase 5 PR 4: request.maxOutputTokens is an optional per-call
        // override (types.ts) -- omitted, this stays exactly 4096, same
        // as every operation before this PR.
        max_tokens: request.maxOutputTokens ?? 4096,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
        tools: [
          {
            name: ANTHROPIC_RESULT_TOOL_NAME,
            description: "Emit the structured result for this analysis operation.",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema produced by z.toJSONSchema, shape not known to the SDK's own tool typing
            input_schema: jsonSchema as any,
          },
        ],
        tool_choice: { type: "tool", name: ANTHROPIC_RESULT_TOOL_NAME },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: "provider_error", message };
    }

    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;

    const toolUseBlock = response.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use"
    );

    if (!toolUseBlock) {
      return {
        ok: false,
        reason: "invalid_structured_output",
        message: "Anthropic response contained no tool_use block despite a forced tool_choice.",
        tokensIn,
        tokensOut,
      };
    }

    const parsed = request.outputSchema.safeParse(toolUseBlock.input);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid_structured_output",
        message: `Structured output failed schema validation: ${parsed.error.message}`,
        tokensIn,
        tokensOut,
      };
    }

    return { ok: true, data: parsed.data, tokensIn, tokensOut };
  }
}

let cachedProvider: AnthropicProvider | null = null;

/**
 * Lazy factory -- constructing this is the point at which "we actually
 * need to call Anthropic" becomes true. Calling this without
 * ANTHROPIC_API_KEY set throws MissingAiConfigError (from config.ts);
 * nothing at module-import time requires the key to be present, so
 * importing this file never breaks a build/typecheck/check run in an
 * environment that hasn't configured it.
 */
export function getAnthropicProvider(): AnthropicProvider {
  if (!cachedProvider) {
    cachedProvider = new AnthropicProvider(getAnthropicApiKey());
  }
  return cachedProvider;
}
