import Link from "next/link";
import { listEvidenceForAdmin } from "@/db/queries/admin";

export default async function AdminEvidenceListPage() {
  const evidence = await listEvidenceForAdmin();
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl italic text-ink-100">Evidence</h1>
        <Link href="/admin/evidence/new" className="border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void">
          + New Evidence
        </Link>
      </div>
      <ul className="divide-y divide-hairline border border-hairline text-sm">
        {evidence.map((e) => (
          <li key={e.id} className="flex items-center justify-between p-3">
            <Link href={`/admin/evidence/${e.id}`} className="text-ink-100 hover:text-accent-brass">
              #{e.id} — {e.description.slice(0, 90)}
            </Link>
            <span className="font-mono text-xs text-ink-600">
              {e.linkedClaimCount === 0 ? "unlinked" : `${e.linkedClaimCount} claim(s)`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
