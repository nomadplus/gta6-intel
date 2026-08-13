import Link from "next/link";
import { listClaimsForAdmin } from "@/db/queries/admin";
import { InvestigationStatusBadge, DevelopmentOutcomeBadge } from "@/components/status/StatusPair";

export default async function AdminClaimsListPage() {
  const claims = await listClaimsForAdmin();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl italic text-ink-100">Claims</h1>
        <Link
          href="/admin/claims/new"
          className="border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void"
        >
          + New Claim
        </Link>
      </div>

      <table className="w-full border border-hairline text-sm">
        <thead>
          <tr className="border-b border-hairline bg-bg-panel text-left font-mono text-[10px] uppercase tracking-wide text-ink-600">
            <th className="p-2">ID</th>
            <th className="p-2">Statement</th>
            <th className="p-2">Investigation</th>
            <th className="p-2">Outcome</th>
            <th className="p-2">Type</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => (
            <tr key={c.id} className="border-b border-hairline hover:bg-bg-panel">
              <td className="p-2 font-mono text-ink-600">#{c.id}</td>
              <td className="p-2">
                <Link href={`/admin/claims/${c.id}`} className="text-ink-100 hover:text-accent-brass">
                  {c.statement}
                </Link>
              </td>
              <td className="p-2">
                <InvestigationStatusBadge status={c.currentInvestigationStatus} />
              </td>
              <td className="p-2">
                <DevelopmentOutcomeBadge outcome={c.currentDevelopmentOutcome} />
              </td>
              <td className="p-2 font-mono text-xs text-ink-600">{c.informationType}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
