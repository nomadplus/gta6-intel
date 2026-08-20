import Link from "next/link";
import { notFound } from "next/navigation";
import { getIngestionJobForAdmin } from "@/db/queries/admin";

function formatDateTime(value: Date | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</div>
      <div className="mt-0.5 text-sm text-ink-100">{value}</div>
    </div>
  );
}

type Props = { params: Promise<{ id: string }> };

/**
 * Deliberately read-only (Phase 4 PR 6): no retry, reprocess, or
 * manual-review action lives on this page. Rate limiting/backoff/retry
 * pipeline logic doesn't exist yet (see docs/architecture.md), so there
 * is nothing for a "retry" button here to safely trigger -- this page is
 * observability only, not a control surface.
 */
export default async function IngestionJobDetailPage({ params }: Props) {
  const { id } = await params;
  const job = await getIngestionJobForAdmin(Number(id));
  if (!job) notFound();

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h1 className="font-display text-2xl italic text-ink-100">Ingestion Job #{job.id}</h1>
          <Link href="/admin/ingest/history" className="font-mono text-xs uppercase tracking-wide text-ink-600 hover:text-accent-brass">
            ← Back to History
          </Link>
        </div>
        <p className="break-all text-sm text-ink-300">{job.submittedUrl}</p>
      </div>

      <div className="grid grid-cols-2 gap-6 border border-hairline p-4">
        <Field label="Status" value={job.status} />
        <Field label="Discovery Provider" value={job.discoveryProviderLabel} />
        <Field label="Initiated By" value={job.initiatedBy} />
        <Field label="Admin" value={job.adminDisplayName ?? "—"} />
        <Field label="Attempt Count" value={job.attemptCount} />
        <Field label="HTTP Status" value={job.httpStatus ?? "—"} />
        <Field label="Content Type" value={job.contentType ?? "—"} />
        <Field label="Content Length" value={job.contentLength ?? "—"} />
        <Field label="Created" value={formatDateTime(job.createdAt)} />
        <Field label="Started" value={formatDateTime(job.startedAt)} />
        <Field label="Next Retry At" value={formatDateTime(job.nextRetryAt)} />
        <Field label="Completed" value={formatDateTime(job.completedAt)} />
      </div>

      <div>
        <div className="font-mono text-[10px] uppercase tracking-wide text-ink-600">Normalized URL</div>
        <p className="mt-0.5 break-all text-sm text-ink-300">{job.normalizedUrl}</p>
      </div>

      {job.failureReason && (
        <div className="border border-signal-disproven/50 p-4">
          <div className="font-mono text-[10px] uppercase tracking-wide text-signal-disproven">Failure Reason</div>
          <p className="mt-1 text-sm text-signal-disproven">{job.failureReason}</p>
        </div>
      )}

      {job.sourceItemId && (
        <div className="border border-signal-confirmed/50 p-4">
          <div className="font-mono text-[10px] uppercase tracking-wide text-signal-confirmed">Linked Source Item</div>
          <Link href={`/admin/source-items/${job.sourceItemId}`} className="mt-1 block text-sm text-ink-100 hover:text-accent-brass">
            #{job.sourceItemId} {job.sourceItemTitle ? `— ${job.sourceItemTitle}` : ""}
          </Link>
        </div>
      )}
    </div>
  );
}
