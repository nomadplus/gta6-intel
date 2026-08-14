import IngestForm from "./IngestForm";
import { listSourcesForAdmin, listSourceItemTypeOptions } from "@/db/queries/admin";

export default async function IngestPage() {
  const [sources, itemTypes] = await Promise.all([listSourcesForAdmin(), listSourceItemTypeOptions()]);

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-3xl italic text-ink-100">Ingest</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-400">
        Submit a URL to fetch, classify, and — when a source is confidently matched — turn into a new
        source item. Every submission runs the same safe-fetch, deduplication, and source-identity checks
        as the rest of the pipeline. Nothing is stored until you explicitly confirm.
      </p>
      <div className="mt-6">
        <IngestForm sources={sources} itemTypes={itemTypes} />
      </div>
    </div>
  );
}
