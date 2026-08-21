import { listAiReviewRecords, listSourceItemClassificationStatus } from "@/db/queries/admin";
import { computeClassificationDisplayStatus, type ClassificationDisplayStatus } from "@/lib/ai/classificationRecoveryLifecycle";
import { runClassificationRecoveryAction } from "./actions";

const STATUS_LABEL: Record<ClassificationDisplayStatus, string> = {
  unclassified: "Unclassified",
  in_progress: "In progress",
  stale: "Stale — recovery available",
  failed: "Failed",
  succeeded: "Succeeded",
};

const STATUS_CLASS: Record<ClassificationDisplayStatus, string> = {
  unclassified: "text-ink-600",
  in_progress: "text-accent-brass",
  stale: "text-signal-disproven",
  failed: "text-signal-disproven",
  succeeded: "text-signal-confirmed",
};

function recoveryButtonLabel(status: ClassificationDisplayStatus): string {
  if (status === "failed") return "Retry classification";
  if (status === "stale") return "Recover & retry";
  return "Run classification";
}

export default async function AdminReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ recoveryStatus?: string; recoveryError?: string; sourceItemId?: string }>;
}) {
  const { recoveryStatus, recoveryError, sourceItemId } = await searchParams;
  const records = await listAiReviewRecords();
  const classificationRows = await listSourceItemClassificationStatus();
  const now = new Date();

  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-3xl italic text-ink-100">AI / Admin Review</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Read-only record of AI recommendations and the admin decisions made on them. No live AI
        processing happens in Phase 3 — this is historical review of the Phase 1 seed data only,
        and the future home for an active recommendation queue once automated analysis exists.
      </p>

      {recoveryError && (
        <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">
          {recoveryError}
        </p>
      )}
      {recoveryStatus && (
        <p className="mt-4 text-sm text-ink-400">
          Recovery for source item #{sourceItemId}: <span className="font-mono text-ink-100">{recoveryStatus}</span>
        </p>
      )}

      <h2 className="mt-10 font-display text-xl italic text-ink-100">Source item classification status</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        classify_relevance status per source item (Phase 5 PR 3) — advisory metadata only. A
        classification, or a missing/failed/stale attempt, never hides, deletes, or mutates the
        underlying source item.
      </p>

      {classificationRows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-600">No source items yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline border border-hairline text-sm">
          {classificationRows.map((row) => {
            const status = computeClassificationDisplayStatus(
              row.jobId !== null && row.jobStatus !== null && row.jobCreatedAt !== null
                ? { status: row.jobStatus, createdAt: row.jobCreatedAt, startedAt: row.jobStartedAt }
                : null,
              now
            );
            const canRecover = status === "unclassified" || status === "stale" || status === "failed";

            return (
              <li key={row.sourceItemId} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-ink-100">{row.title ?? row.url}</p>
                    <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                      source item #{row.sourceItemId}
                    </p>
                  </div>
                  <span className={`font-mono text-xs uppercase tracking-wide ${STATUS_CLASS[status]}`}>
                    {STATUS_LABEL[status]}
                  </span>
                </div>

                {status === "succeeded" && (
                  <p className="mt-2 text-xs text-ink-400">
                    {row.relevance ?? "—"} · confidence {row.confidence !== null ? row.confidence.toFixed(2) : "—"}
                    {row.reasoning && <> — {row.reasoning}</>}
                  </p>
                )}
                {status === "failed" && row.jobError && (
                  <p className="mt-2 text-xs text-signal-disproven">{row.jobError}</p>
                )}
                {status === "stale" && (
                  <p className="mt-2 text-xs text-ink-600">
                    An in-flight attempt started but never reached a terminal outcome within the
                    staleness window — safe to reclaim and retry.
                  </p>
                )}

                {canRecover && (
                  <form action={runClassificationRecoveryAction} className="mt-3">
                    <input type="hidden" name="sourceItemId" value={row.sourceItemId} />
                    <button
                      type="submit"
                      className="border border-accent-brass px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
                    >
                      {recoveryButtonLabel(status)}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mt-10 font-display text-xl italic text-ink-100">All AI results</h2>

      {records.length === 0 ? (
        <p className="mt-8 text-sm text-ink-600">No AI recommendation records yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-hairline border border-hairline text-sm">
          {records.map((r) => (
            <li key={r.aiResultId} className="p-4">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                <span>{r.provider} / {r.model}</span>
                <span>·</span>
                <span>{r.operation}</span>
                <span>·</span>
                <span>confidence {r.confidence ? Number(r.confidence).toFixed(2) : "—"}</span>
              </div>
              <p className="mt-2 text-ink-100">{r.reasoning}</p>
              {r.claimId && <p className="mt-1 font-mono text-xs text-ink-600">claim #{r.claimId}</p>}
              {r.decisionAction && (
                <p
                  className={`mt-2 border-l-2 pl-2 text-xs ${
                    r.decisionAction === "reject" ? "border-signal-disproven text-signal-disproven" : "border-signal-confirmed text-signal-confirmed"
                  }`}
                >
                  {r.decisionAction.toUpperCase()}: {r.decisionNotes}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
