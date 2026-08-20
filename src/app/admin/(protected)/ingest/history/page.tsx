import Link from "next/link";
import { listIngestionJobsForAdmin } from "@/db/queries/admin";

function formatDateTime(value: Date | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default async function IngestionJobHistoryPage() {
  const jobs = await listIngestionJobsForAdmin();

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h1 className="font-display text-3xl italic text-ink-100">Ingestion History</h1>
        <Link href="/admin/ingest" className="font-mono text-xs uppercase tracking-wide text-ink-600 hover:text-accent-brass">
          ← Back to Ingest
        </Link>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Record of every ingestion attempt — what was submitted, how it was discovered, its current
        status, and why it succeeded or failed. Nothing is re-fetched or re-processed from here — a
        job awaiting review can be confirmed from its own entry below, using only what was already
        retrieved.
      </p>

      {jobs.length === 0 ? (
        <p className="mt-8 text-sm text-ink-600">No ingestion jobs yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-hairline border border-hairline text-sm">
          {jobs.map((job) => (
            <li key={job.id} className="p-3">
              <div className="flex items-center justify-between gap-4">
                <Link href={`/admin/ingest/history/${job.id}`} className="min-w-0 flex-1 truncate text-ink-100 hover:text-accent-brass">
                  {job.submittedUrl}
                </Link>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-accent-brass">
                  {job.status}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">
                #{job.id} · {job.discoveryProviderLabel} · {job.initiatedBy}
                {job.adminDisplayName ? ` · ${job.adminDisplayName}` : ""} · {formatDateTime(job.createdAt)}
              </div>
              {job.failureReason && <p className="mt-1 text-xs text-signal-disproven">{job.failureReason}</p>}
              {job.sourceItemId && (
                <p className="mt-1 font-mono text-xs text-ink-600">
                  → source item #{job.sourceItemId}
                  {job.sourceItemTitle ? ` "${job.sourceItemTitle}"` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
