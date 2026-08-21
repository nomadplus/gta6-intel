import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "@/lib/ai/types";

/**
 * Test-only AiProvider double for Phase 5 PR 1's checks. Deliberately
 * lives under src/checks/helpers/, NOT src/lib/ai/providers/ -- it must
 * never be reachable as a production-configurable provider (there is no
 * env var or registry that could select "fake" at runtime; the only way
 * to get one is to import this file directly, which no application code
 * outside src/checks does).
 *
 * Each call to complete() consumes the next queued response in FIFO
 * order, so a single check can exercise a sequence of distinct
 * outcomes (e.g. one success, one malformed-output, one provider-error)
 * against the exact same runAiOperation() code path a real provider
 * would go through -- proving the abstraction and the persistence
 * lifecycle, not just the fake's own bookkeeping.
 *
 * Mirrors AnthropicProvider's own contract exactly: a "malformed output"
 * queued response is still run through request.outputSchema.safeParse()
 * here, the same as the real provider does, rather than trusting a
 * pre-baked ok:false -- this is what makes the "invalid structured
 * output" check exercise the SAME validation path production traffic
 * would hit, not a shortcut around it.
 */

export type FakeProviderResponse =
  | { kind: "success"; rawOutput: unknown; tokensIn?: number; tokensOut?: number }
  | { kind: "provider_error"; message: string; tokensIn?: number; tokensOut?: number }
  | { kind: "throw"; error: Error };

export class FakeAiProvider implements AiProvider {
  readonly name: string;
  private readonly queue: FakeProviderResponse[];
  public readonly receivedRequests: AiCompletionRequest<unknown>[] = [];

  /**
   * `name` defaults to "fake" but can be overridden per instance --
   * used by aiRunOperation.check.ts's provider-swap coverage to prove
   * runAiOperation persists whichever provider.name it was actually
   * given (i.e. it never hardcodes "anthropic" or "fake" anywhere),
   * without requiring a second real provider implementation to do so.
   */
  constructor(responses: FakeProviderResponse[], name = "fake") {
    this.queue = [...responses];
    this.name = name;
  }

  async complete<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    this.receivedRequests.push(request as AiCompletionRequest<unknown>);

    const next = this.queue.shift();
    if (!next) {
      throw new Error("FakeAiProvider.complete() called more times than responses were queued.");
    }

    if (next.kind === "throw") {
      throw next.error;
    }

    if (next.kind === "provider_error") {
      return {
        ok: false,
        reason: "provider_error",
        message: next.message,
        tokensIn: next.tokensIn,
        tokensOut: next.tokensOut,
      };
    }

    // kind === "success" -- still validated against the caller's real
    // schema, exactly as AnthropicProvider validates its own tool_use
    // input. A test that queues a rawOutput not matching outputSchema
    // is deliberately exercising the "invalid_structured_output" path,
    // not bypassing it.
    const parsed = request.outputSchema.safeParse(next.rawOutput);
    const tokensIn = next.tokensIn ?? 0;
    const tokensOut = next.tokensOut ?? 0;

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
