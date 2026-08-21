import "server-only";

/**
 * Phase 5 PR 2: emergency stop for real AI provider execution.
 *
 * Deliberately the OPPOSITE default direction from most config in this
 * project (compare requireCronSecret.ts / config.ts's MissingAiConfigError,
 * both of which fail closed on absence): AI_KILL_SWITCH_ENGAGED being unset
 * is the normal, unblocked operating state. This variable is an override
 * switch, not a mandatory credential -- there is nothing to "fail closed"
 * about its mere absence, unlike a missing API key or auth secret.
 *
 * Once an operator DOES set it, however, ambiguity resolves in favor of
 * STOPPING, not continuing: this is an emergency switch, so a typo'd or
 * unexpected value (e.g. "ture", "1", "yes") must still engage it rather
 * than silently doing nothing -- a false-positive stop (blocked when not
 * intended) is cheap and immediately visible; a false-negative (an
 * intended stop that doesn't take effect) is exactly the uncontrolled-spend
 * scenario this exists to prevent. Only the exact string "false", or
 * leaving the variable unset entirely, is treated as disengaged.
 *
 * Applies uniformly regardless of which AiProvider is passed into
 * runAiOperation() -- including the test-only FakeAiProvider. See
 * evaluateAiSafety.ts's header for why distinguishing "real" from "test"
 * execution here would be a weaker, spoofable guard than a single
 * provider-agnostic boundary.
 */
export function isKillSwitchEngaged(): boolean {
  const raw = process.env.AI_KILL_SWITCH_ENGAGED;
  if (raw === undefined || raw === "false") {
    return false;
  }
  return true;
}
