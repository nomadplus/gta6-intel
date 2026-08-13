import Link from "next/link";
import { listSourceItemsForAdmin } from "@/db/queries/admin";

export default async function AdminSourceItemsListPage() {
  const items = await listSourceItemsForAdmin();
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl italic text-ink-100">Source Items</h1>
        <Link href="/admin/source-items/new" className="border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void">
          + New Source Item
        </Link>
      </div>
      <ul className="divide-y divide-hairline border border-hairline text-sm">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between p-3">
            <div>
              <Link href={`/admin/source-items/${i.id}`} className="text-ink-100 hover:text-accent-brass">
                {i.title ?? i.url}
              </Link>
              <div className="font-mono text-xs text-ink-600">{i.sourceName} · {i.itemTypeLabel}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
