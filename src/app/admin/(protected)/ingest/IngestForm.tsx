"use client";
import { useActionState } from "react";
import {
  submitIngestionAction,
  confirmIngestionAction,
  type SubmitActionState,
  type ConfirmActionState,
  type SerializedPipelineResult,
} from "./actions";

const inputClass =
  "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass =
  "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void disabled:opacity-50";
const labelClass = "mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600";
const metaLabelClass = "font-mono text-[10px] uppercase tracking-wide text-ink-600";
const errorClass = "border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven";
const panelClass = "border border-hairline bg-bg-panel p-4 text-sm";

const initialSubmitState: SubmitActionState = { status: "idle" };
const initialConfirmState: ConfirmActionState = { status: "idle" };

export default function IngestForm({
  sources,
  itemTypes,
}: {
  sources: { id: number; name: string }[];
  itemTypes: { id: number; label: string }[];
}) {
  const [submitState, submitFormAction, submitPending] = useActionState(submitIngestionAction, initialSubmitState);
  const [confirmState, confirmFormAction, confirmPending] = useActionState(confirmIngestionAction, initialConfirmState);

  return (
    <div className="space-y-8">
      <form action={submitFormAction} className="space-y-4">
        <div>
          <label className={labelClass}>URL</label>
          <input name="url" type="url" required placeholder="https://…" className={inputClass} />
        </div>
        <button type="submit" disabled={submitPending} className={submitClass}>
          {submitPending ? "Fetching…" : "Submit URL"}
        </button>
      </form>

      {submitState.status === "error" && <p className={errorClass}>{submitState.error}</p>}

      {submitState.status === "success" && (
        <ResultPanel result={submitState.result} sources={sources} />
      )}

      {submitState.status === "success" && submitState.result.kind === "ready_for_confirmation" && submitState.reviewToken && (
        <form action={confirmFormAction} className="space-y-4 border-t border-hairline pt-6">
          <input type="hidden" name="jobId" value={submitState.result.jobId} />
          <input type="hidden" name="reviewToken" value={submitState.reviewToken} />

          <div>
            <label className={labelClass}>Source</label>
            <select name="sourceId" required defaultValue={submitState.result.proposedSourceId} className={inputClass}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Item type</label>
            <select name="itemTypeId" required className={inputClass}>
              {itemTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Title</label>
            <input name="title" defaultValue={submitState.result.metadata.title ?? ""} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Author</label>
            <input name="author" defaultValue={submitState.result.metadata.author ?? ""} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Published date</label>
            <input
              name="publishedAt"
              type="date"
              defaultValue={submitState.result.metadata.publishedAt?.slice(0, 10) ?? ""}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Excerpt (max 600 chars)</label>
            <textarea
              name="excerpt"
              rows={3}
              maxLength={600}
              defaultValue={submitState.result.metadata.excerpt ?? ""}
              className={inputClass}
            />
          </div>

          {confirmState.status === "error" && <p className={errorClass}>{confirmState.error}</p>}

          <button type="submit" disabled={confirmPending} className={submitClass}>
            {confirmPending ? "Creating…" : "Confirm & Create Source Item"}
          </button>
        </form>
      )}
    </div>
  );
}

function ResultPanel({
  result,
  sources,
}: {
  result: SerializedPipelineResult;
  sources: { id: number; name: string }[];
}) {
  switch (result.kind) {
    case "existing_inflight":
      return (
        <div className={panelClass}>
          <p className="text-ink-100">Already queued — an ingestion job for this URL is currently {result.existingStatus}.</p>
          <p className={`mt-1 ${metaLabelClass}`}>job #{result.existingJobId}</p>
        </div>
      );

    case "duplicate":
      return (
        <div className={panelClass}>
          <p className="text-ink-100">Already archived — this content matches an existing source item.</p>
          <p className={`mt-1 ${metaLabelClass}`}>matched on {result.matchedOn}</p>
          <a href={`/admin/source-items/${result.sourceItemId}`} className="mt-2 inline-block text-accent-brass hover:underline">
            View source item #{result.sourceItemId} →
          </a>
        </div>
      );

    case "failed":
      return (
        <div className={panelClass}>
          <p className="text-signal-disproven">Fetch failed — {result.status}</p>
          <p className="mt-1 text-ink-300">{result.failureReason}</p>
        </div>
      );

    case "needs_review":
      return (
        <div className={panelClass}>
          <p className="text-ink-100">Needs manual review — {formatNeedsReviewReason(result.reason)}</p>
          <p className="mt-1 text-ink-400">
            No confirm action is offered here for review-only outcomes — resolve this later from{" "}
            <a href={`/admin/ingest/history/${result.jobId}`} className="text-accent-brass hover:underline">
              this job&apos;s History entry
            </a>
            , once it&apos;s been recorded.
          </p>
          {result.candidateSourceItemId && (
            <a
              href={`/admin/source-items/${result.candidateSourceItemId}`}
              className="mt-2 inline-block text-accent-brass hover:underline"
            >
              View possible match — source item #{result.candidateSourceItemId} →
            </a>
          )}
          {result.candidateSourceIds && result.candidateSourceIds.length > 0 && (
            <p className="mt-2 text-ink-400">
              Candidate sources:{" "}
              {result.candidateSourceIds
                .map((id) => sources.find((s) => s.id === id)?.name ?? `#${id}`)
                .join(", ")}
            </p>
          )}
          {result.metadata && (
            <dl className="mt-3 space-y-1 text-ink-400">
              <MetadataRow label="Retrieved URL" value={result.metadata.url} />
              <MetadataRow label="Title" value={result.metadata.title} />
            </dl>
          )}
        </div>
      );

    case "ready_for_confirmation":
      return (
        <div className={panelClass}>
          <p className="text-signal-confirmed">Ready for confirmation — a single matching source was identified.</p>
          <dl className="mt-3 space-y-1 text-ink-400">
            <MetadataRow label="Retrieved URL" value={result.metadata.url} />
            <MetadataRow label="Canonical URL" value={result.metadata.canonicalUrl} />
            <MetadataRow label="Title" value={result.metadata.title} />
            <MetadataRow label="Author" value={result.metadata.author} />
            <MetadataRow label="Published" value={result.metadata.publishedAt?.slice(0, 10) ?? null} />
          </dl>
          {result.hashCoincidenceSourceItemIds.length > 0 && (
            <p className="mt-2 text-ink-400">
              Note: identical content hash also found at source item(s){" "}
              {result.hashCoincidenceSourceItemIds.map((id) => `#${id}`).join(", ")} — review for provenance before confirming.
            </p>
          )}
        </div>
      );
  }
}

function MetadataRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className={metaLabelClass}>{label}</dt>
      <dd className="text-ink-100">{value}</dd>
    </div>
  );
}

function formatNeedsReviewReason(reason: string): string {
  switch (reason) {
    case "hash_mismatch":
      return "same URL as an existing item, but different content.";
    case "no_source_match":
      return "the fetched hostname didn't match any known source.";
    case "ambiguous_source_match":
      return "the fetched hostname matched more than one known source.";
    case "ambiguous_forbidden_response":
      return "the site returned an HTTP 403 with no way to tell whether it's a bot-block, geo-block, or paywall.";
    default:
      return reason;
  }
}
