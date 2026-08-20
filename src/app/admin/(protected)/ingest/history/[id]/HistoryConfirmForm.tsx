"use client";
import { useActionState } from "react";
import { confirmIngestionAction, type ConfirmActionState } from "../../actions";

const inputClass =
  "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass =
  "border border-accent-brass px-4 py-2 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void disabled:opacity-50";
const labelClass = "mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600";
const errorClass = "border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven";

const initialConfirmState: ConfirmActionState = { status: "idle" };

/**
 * Phase 4 PR 7: the History-page counterpart to IngestForm.tsx's
 * `ready_for_confirmation` form. Reuses `confirmIngestionAction` (and, via
 * it, `finalizeIngestionConfirmation`) completely unchanged -- the only
 * difference from the immediate-response form is that `reviewToken` here
 * was re-signed from this job's own persisted columns
 * (`prepareHistoryReviewConfirmation`, called server-side by this page's
 * parent component) rather than issued moments ago by the pipeline.
 *
 * Deliberately no "proposed source" default (Section: matching hints are
 * not persisted, per product decision) -- the admin always picks a source
 * explicitly here, for both the `ready_for_confirmation` and true
 * `needs_review` cases alike, since the DB can't distinguish which one
 * this job originally was.
 */
export default function HistoryConfirmForm({
  jobId,
  reviewToken,
  metadata,
  sources,
  itemTypes,
}: {
  jobId: number;
  reviewToken: string;
  metadata: {
    title: string | null;
    author: string | null;
    publishedAt: string | null; // ISO string
    excerpt: string | null;
  };
  sources: { id: number; name: string }[];
  itemTypes: { id: number; label: string }[];
}) {
  const [confirmState, confirmFormAction, confirmPending] = useActionState(confirmIngestionAction, initialConfirmState);

  return (
    <form action={confirmFormAction} className="space-y-4 border-t border-hairline pt-6">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="reviewToken" value={reviewToken} />

      <div>
        <label className={labelClass}>Source</label>
        <select name="sourceId" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Select a source…
          </option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Item type</label>
        <select name="itemTypeId" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Select an item type…
          </option>
          {itemTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Title</label>
        <input name="title" defaultValue={metadata.title ?? ""} className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Author</label>
        <input name="author" defaultValue={metadata.author ?? ""} className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Published date</label>
        <input
          name="publishedAt"
          type="date"
          defaultValue={metadata.publishedAt?.slice(0, 10) ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass}>Excerpt (max 600 chars)</label>
        <textarea
          name="excerpt"
          rows={3}
          maxLength={600}
          defaultValue={metadata.excerpt ?? ""}
          className={inputClass}
        />
      </div>

      {confirmState.status === "error" && <p className={errorClass}>{confirmState.error}</p>}

      <button type="submit" disabled={confirmPending} className={submitClass}>
        {confirmPending ? "Creating…" : "Confirm & Create Source Item"}
      </button>
    </form>
  );
}
