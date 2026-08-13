import { notFound } from "next/navigation";
import { getEvidenceForAdmin, listClaimsForAdmin, getEvidenceClaimLinks } from "@/db/queries/admin";
import { linkEvidenceToClaimFromEvidenceAction, unlinkEvidenceFromEvidencePageAction } from "../actions";

const inputClass = "w-full border border-hairline bg-bg-void px-3 py-2 text-sm text-ink-100 focus-visible:border-accent-brass";
const submitClass = "border border-accent-brass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-accent-brass hover:bg-accent-brass hover:text-bg-void";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> };

export default async function AdminEvidenceDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const evidenceId = Number(id);
  const evidence = await getEvidenceForAdmin(evidenceId);
  if (!evidence) notFound();

  const [links, allClaims] = await Promise.all([
    getEvidenceClaimLinks(evidenceId),
    listClaimsForAdmin(),
  ]);

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-2xl italic text-ink-100">Evidence #{evidence.id}</h1>
      <p className="mt-2 text-sm text-ink-300">{evidence.description}</p>
      <p className="mt-1 font-mono text-xs text-ink-600">{evidence.evidenceType}</p>

      {error && <p className="mt-4 border border-signal-disproven/50 px-3 py-2 text-sm text-signal-disproven">{error}</p>}
      {saved && <p className="mt-4 border border-signal-confirmed/50 px-3 py-2 text-sm text-signal-confirmed">Saved.</p>}

      <section className="mt-8">
        <h2 className="font-mono text-xs uppercase tracking-wide text-accent-brass">Linked Claims</h2>
        <p className="mt-1 text-xs text-ink-600">
          The same evidence can support, contradict, or merely mention more than one claim.
        </p>
        <ul className="mt-3 divide-y divide-hairline border border-hairline text-sm">
          {links.map((l) => (
            <li key={l.linkId} className="flex items-center justify-between p-2">
              <span>
                #{l.claimId} — {l.statement.slice(0, 70)} <span className="font-mono text-xs text-ink-600">({l.stance})</span>
              </span>
              <form action={unlinkEvidenceFromEvidencePageAction}>
                <input type="hidden" name="linkId" value={l.linkId} />
                <input type="hidden" name="evidenceId" value={evidence.id} />
                <button className="font-mono text-xs text-ink-600 hover:text-signal-disproven">unlink</button>
              </form>
            </li>
          ))}
          {links.length === 0 && <li className="p-2 text-ink-600">Not linked to any claim yet — this is a valid state.</li>}
        </ul>

        <form action={linkEvidenceToClaimFromEvidenceAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-hairline pt-4">
          <input type="hidden" name="evidenceId" value={evidence.id} />
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Claim</label>
            <select name="claimId" required className={inputClass}>
              {allClaims.map((c) => (
                <option key={c.id} value={c.id}>#{c.id} — {c.statement.slice(0, 60)}</option>
              ))}
            </select>
          </div>
          <div className="min-w-[140px]">
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-600">Stance</label>
            <select name="stance" className={inputClass}>
              <option value="supports">Supports</option>
              <option value="contradicts">Contradicts</option>
              <option value="mentions">Mentions</option>
            </select>
          </div>
          <button type="submit" className={submitClass}>Link</button>
        </form>
      </section>
    </div>
  );
}
