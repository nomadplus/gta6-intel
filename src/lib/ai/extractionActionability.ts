/**
 * Phase 5 PR 4. Pure mapping from an extraction display status (see
 * extractClaimsRecoveryLifecycle.ts's ExtractionDisplayStatus, 5 states:
 * unextracted / in_progress / stale / failed / succeeded) to whether the
 * admin review page should show an action control, and which one.
 *
 * Deliberately its own module, not inlined into
 * src/app/admin/(protected)/review/page.tsx, so this decision logic is
 * checkable in isolation without importing a Next.js page component.
 *
 * Locked UI rule (Phase 5 PR 4): exactly 3 of the 5 display states are
 * actionable -- unextracted ("Extract claims"), stale ("Recover"), and
 * failed ("Retry"). in_progress and succeeded both render with NO action
 * control at all. In particular, a SUCCEEDED extraction never offers a
 * "re-extract" action in this PR -- this is a deliberate product
 * decision, not a limitation of the underlying data: nothing at the
 * migration/index or recovery-mutation layer prevents a future
 * deliberate re-analysis workflow (see migration 0015 and
 * extractClaimsRecovery.ts's own header comments) -- this module simply
 * doesn't expose one yet.
 */
import type { ExtractionDisplayStatus } from "./extractClaimsRecoveryLifecycle";

export type ExtractionAction = "extract" | "recover" | "retry";

/** True for exactly 3 of the 5 ExtractionDisplayStatus values -- see header. */
export function canTriggerExtraction(status: ExtractionDisplayStatus): boolean {
  return status === "unextracted" || status === "stale" || status === "failed";
}

/** null for the two non-actionable states (in_progress, succeeded). */
export function extractionAction(status: ExtractionDisplayStatus): ExtractionAction | null {
  if (status === "unextracted") return "extract";
  if (status === "stale") return "recover";
  if (status === "failed") return "retry";
  return null;
}

const ACTION_LABEL: Record<ExtractionAction, string> = {
  extract: "Extract claims",
  recover: "Recover",
  retry: "Retry",
};

/** null for the two non-actionable states -- callers must not render a button in that case. */
export function extractionButtonLabel(status: ExtractionDisplayStatus): string | null {
  const action = extractionAction(status);
  return action ? ACTION_LABEL[action] : null;
}
