import { listAiReviewRecords } from "@/db/queries/admin";

/**
 * Admin Review workspace (PR-A): relocated from the bottom of
 * /admin/review. Same query (listAiReviewRecords), same rendering, same
 * semantics as before this PR -- only the route changed, following the
 * existing /admin/ingest -> /admin/ingest/history precedent already in
 * this codebase. This is an unbounded audit log of every AI
 * recommendation and the admin decision (if any) made on it; it is
 * display-only and never mutates anything.
 */
export default async function AiReviewHistoryPage() {
  const records = await listAiReviewRecords();

  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-3xl italic text-ink-100">AI Review History</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Full record of AI recommendations and the admin decisions made on them, across every
        operation (classify_relevance, extract_claims, detect_duplicates, compare_claims,
        analyse_provenance). This is a read-only audit log -- for the active review queue, see{" "}
        <a href="/admin/review" className="text-accent-brass hover:underline">
          AI / Admin Review
        </a>
        .
      </p>

      {records.length === 0 ? (
        <p className="mt-8 text-sm text-ink-600">No AI recommendation records yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-hairline border border-hairline text-sm">
          {records.map((r) => (
            <li key={`${r.aiResultId}-${r.decisionId ?? "none"}`} className="p-4">
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
