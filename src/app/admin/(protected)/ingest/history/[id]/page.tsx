import Link from "next/link";
import { notFound } from "next/navigation";
import { getIngestionJobForAdmin, listSourcesForAdmin, listSourceItemTypeOptions } from "@/db/queries/admin";
import { prepareHistoryReviewConfirmation, JobNotReviewableError } from "@/db/mutations/ingestion";
import HistoryConfirmForm from "./HistoryConfirmForm";

/** Informational only (Section 12/18) -- never blocks confirmation, never triggers a re-fetch, just tells the admin the fetched content may no longer match the live page. */
const STALENESS_WARNING_THRESHOLD_HOURS = 24;

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
 * Mostly read-only (Phase 4 PR 6), with one exception added in PR 7: an
 * unresolved `needs_review` job (status `needs_review`, no linked source
 * item) can be confirmed from here, via a freshly re-signed review token
 * derived from this job's own persisted columns (migration 0009,
 * `prepareHistoryReviewConfirmation`) -- not from re-fetching the URL, and
 * not from any client-supplied data. This is still NOT a retry/reprocess
 * surface: nothing here re-runs the fetch, re-classifies the job, or
 * changes its dedup/source-identity outcome -- it only lets an admin do,
 * later, what `IngestForm.tsx` already lets them do immediately after
 * submission. Rate limiting/backoff/retry pipeline logic still doesn't
 * exist (see docs/architecture.md).
 */
export default async function IngestionJobDetailPage({ params }: Props) {
  const { id } = await params;
  const job = await getIngestionJobForAdmin(Number(id));
  if (!job) notFound();

  const isUnresolvedReview = job.status === "needs_review" && job.sourceItemId === null;

  let reviewPreparation: Awaited<ReturnType<typeof prepareHistoryReviewConfirmation>> | null = null;
  let notReviewableReason: string | null = null;
  let sources: Awaited<ReturnType<typeof listSourcesForAdmin>> = [];
  let itemTypes: Awaited<ReturnType<typeof listSourceItemTypeOptions>> = [];

  if (isUnresolvedReview) {
    try {
      [reviewPreparation, sources, itemTypes] = await Promise.all([
        prepareHistoryReviewConfirmation(job.id),
        listSourcesForAdmin(),
        listSourceItemTypeOptions(),
      ]);
    } catch (err) {
      // Expected, non-exceptional case: the ambiguous-403 outcome (no fetch
      // ever succeeded, so nothing was ever extracted to persist) or a job
      // that predates PR 7. Anything else re-throws -- an unexpected error
      // here is a real bug, not a normal "can't resolve this one" state.
      if (err instanceof JobNotReviewableError) {
        notReviewableReason = err.message;
      } else {
        throw err;
      }
    }
  }

  const ageHours = (Date.now() - new Date(job.createdAt).getTime()) / (1000 * 60 * 60);
  const isStale = ageHours >= STALENESS_WARNING_THRESHOLD_HOURS;

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

      {isUnresolvedReview && reviewPreparation && (
        <div>
          <div className="border border-hairline bg-bg-panel p-4">
            <p className="text-sm text-ink-100">
              This job is still awaiting review. You can confirm it below, exactly as if you were
              resolving it right after submission.
            </p>
            {isStale && (
              <p className="mt-2 text-xs text-ink-400">
                Note: this content was fetched {formatDateTime(job.createdAt)} — over{" "}
                {STALENESS_WARNING_THRESHOLD_HOURS} hours ago. The live page may have changed since
                then; this only confirms what was originally retrieved.
              </p>
            )}
            <dl className="mt-3 space-y-1 text-ink-400">
              {reviewPreparation.metadata.title && (
                <div className="flex gap-2">
                  <dt className="font-mono text-[10px] uppercase tracking-wide text-ink-600">Title</dt>
                  <dd className="text-ink-100">{reviewPreparation.metadata.title}</dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="font-mono text-[10px] uppercase tracking-wide text-ink-600">Retrieved URL</dt>
                <dd className="break-all text-ink-100">{reviewPreparation.metadata.url}</dd>
              </div>
            </dl>
          </div>
          <HistoryConfirmForm
            jobId={reviewPreparation.jobId}
            reviewToken={reviewPreparation.reviewToken}
            metadata={{
              title: reviewPreparation.metadata.title,
              author: reviewPreparation.metadata.author,
              publishedAt: reviewPreparation.metadata.publishedAt
                ? new Date(reviewPreparation.metadata.publishedAt).toISOString()
                : null,
              excerpt: reviewPreparation.metadata.excerpt,
            }}
            sources={sources}
            itemTypes={itemTypes}
          />
        </div>
      )}

      {isUnresolvedReview && notReviewableReason && (
        <div className="border border-hairline p-4">
          <p className="text-sm text-ink-400">
            This job cannot be resolved from here: no content was ever retrieved to review (for
            example, an ambiguous access-blocked response). Resubmit the URL from{" "}
            <Link href="/admin/ingest" className="text-accent-brass hover:underline">
              Ingest
            </Link>{" "}
            to try again.
          </p>
        </div>
      )}
    </div>
  );
}
