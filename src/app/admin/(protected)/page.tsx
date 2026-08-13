import { getDashboardStats, getRecentAdminActivity } from "@/db/queries/admin";
import { investigationStatusDisplay, developmentOutcomeDisplay } from "@/lib/statusDisplay";

export default async function AdminDashboardPage() {
  const [stats, activity] = await Promise.all([getDashboardStats(), getRecentAdminActivity(15)]);

  const byInvestigation = (stats.by_investigation ?? {}) as Record<string, number>;
  const byOutcome = (stats.by_outcome ?? {}) as Record<string, number>;

  return (
    <div className="max-w-5xl">
      <h1 className="font-display text-3xl italic text-ink-100">Dashboard</h1>

      <div className="mt-6 grid grid-cols-2 gap-px border border-hairline bg-hairline sm:grid-cols-4">
        <Stat label="Total Claims" value={stats.total_claims} />
        <Stat label="Unresolved" value={stats.unresolved_claims} />
        <Stat label="Sources" value={stats.total_sources} />
        <Stat label="Source Items" value={stats.total_source_items} />
        <Stat label="Evidence Records" value={stats.total_evidence} />
      </div>

      <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2">
        <section>
          <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-ink-600">Claims by Investigation Status</h2>
          <ul className="space-y-1 text-sm">
            {Object.entries(investigationStatusDisplay).map(([key, d]) => (
              <li key={key} className="flex justify-between border-b border-hairline py-1">
                <span className="text-ink-300">{d.label}</span>
                <span className="font-mono text-ink-100">{byInvestigation[key] ?? 0}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-ink-600">Claims by Development Outcome</h2>
          <ul className="space-y-1 text-sm">
            {Object.entries(developmentOutcomeDisplay).map(([key, d]) => (
              <li key={key} className="flex justify-between border-b border-hairline py-1">
                <span className="text-ink-300">{d.label}</span>
                <span className="font-mono text-ink-100">{byOutcome[key] ?? 0}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-ink-600">Recent Admin Activity</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-ink-600">No admin activity recorded yet.</p>
        ) : (
          <ul className="divide-y divide-hairline border border-hairline">
            {activity.map((a) => (
              <li key={a.id} className="flex items-center justify-between p-3 text-sm">
                <span className="text-ink-100">{a.summary}</span>
                <span className="font-mono text-xs text-ink-600">
                  {a.adminName} · {new Date(a.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-bg-panel p-4">
      <div className="font-mono text-2xl text-ink-100">{value}</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-600">{label}</div>
    </div>
  );
}
