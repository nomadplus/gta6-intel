import { listAiReviewRecords } from "@/db/queries/admin";

export default async function AdminReviewPage() {
  const records = await listAiReviewRecords();

  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-3xl italic text-ink-100">AI / Admin Review</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Read-only record of AI recommendations and the admin decisions made on them. No live AI
        processing happens in Phase 3 — this is historical review of the Phase 1 seed data only,
        and the future home for an active recommendation queue once automated analysis exists.
      </p>

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
