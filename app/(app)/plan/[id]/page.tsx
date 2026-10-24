import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "../../../../components/CopyButton";
import { PlanObservationCard } from "../../../../components/PlanCards";
import { formatDay, formatMoney, formatStamp } from "../../../../components/format";
import { toLocoProposal } from "../../../../src/core/loco";
import type { Observation, Plan } from "../../../../src/core/schema";
import { OWNER, store } from "../../../../src/server/store";
import { getPlan, planNotices } from "../../../../src/server/plan";
import { archivePlanAction, choosePlaceAction } from "../actions";

export const metadata: Metadata = { title: "Plan" };
export const dynamic = "force-dynamic";

const SECTIONS = [
  { key: "flights", title: "Flights", empty: "No live fares found for these dates. Use the links." },
  { key: "stay", title: "Stay", empty: "No live stays. Use the links." },
  { key: "car", title: "Car", empty: "Rental cars are links only for now." },
  { key: "activities", title: "Activities", empty: "No activities found. Use the links." },
  { key: "events", title: "Events", empty: "No events found for these dates." },
] as const;

function Notices({ id }: { id: string }) {
  const notices = planNotices(OWNER, id);
  if (!notices.length) return null;
  return (
    <details>
      <summary>What each source did</summary>
      <ul className="grid gap-1 t-caption">
        {notices.map((n, i) => (
          <li key={i} className={n.ok ? "muted" : ""}>
            <strong>{n.source}</strong>: {n.ok ? `${n.calls} call${n.calls === 1 ? "" : "s"}` : (n.error ?? "did not run")}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Choosing({ plan, now }: { plan: Plan; now: Date }) {
  return (
    <section aria-labelledby="where" className="grid gap-2">
      <h2 id="where" className="t-sub">
        Where to?
      </h2>
      <p className="muted t-caption">
        {formatDay(plan.request.window.from)} to {formatDay(plan.request.window.to)} · {plan.request.nights.min === plan.request.nights.max ? plan.request.nights.min : `${plan.request.nights.min}-${plan.request.nights.max}`} nights
        {plan.request.interests.length ? ` · ${plan.request.interests.join(", ")}` : ""}
      </p>
      {plan.candidates.length === 0 ? <div className="empty">No place in the pool fits this request. Try a longer window or fewer interests.</div> : null}
      <div className="cards">
        {plan.candidates.map((c) => (
          <article key={c.place} className="card" aria-label={c.place}>
            <h3 className="t-sub">
              {c.place}
              {c.country ? <span className="muted">, {c.country}</span> : null}
            </h3>
            <ul className="t-caption grid gap-1">
              {c.reasons.slice(0, 5).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {c.cheapest_flight && c.flight_provenance ? (
              <p>
                <span className="price num">{formatMoney(c.cheapest_flight)}</span> <span className="t-caption">per person, return</span>
                <br />
                <span className="muted t-caption">
                  {c.flight_provenance.source} · seen {formatStamp(c.flight_provenance.seen_at, now)}
                </span>
              </p>
            ) : (
              <p className="muted t-caption">no live fare yet</p>
            )}
            <form action={choosePlaceAction} className="form">
              <input type="hidden" name="id" value={plan.id} />
              <input type="hidden" name="place" value={c.place} />
              <details>
                <summary>Pick the dates myself</summary>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor={`from-${c.place}`}>From</label>
                    <input id={`from-${c.place}`} name="from" type="date" />
                  </div>
                  <div className="field">
                    <label htmlFor={`to-${c.place}`}>To</label>
                    <input id={`to-${c.place}`} name="to" type="date" />
                  </div>
                </div>
                <span className="hint">Empty means the cheapest fare found, else the start of your window.</span>
              </details>
              <button type="submit" className="btn btn-primary">
                Choose {c.place}
              </button>
            </form>
          </article>
        ))}
      </div>
    </section>
  );
}

function Planned({ plan, now }: { plan: Plan; now: Date }) {
  const s = store();
  const byId = new Map<string, Observation>();
  for (const key of Object.keys(plan.sections) as (keyof Plan["sections"])[]) {
    for (const id of plan.sections[key]) {
      const o = s.getObservation(id);
      if (o) byId.set(id, o);
    }
  }
  const proposal = JSON.stringify(toLocoProposal(plan, [...byId.values()]), null, 2);
  return (
    <>
      {SECTIONS.map(({ key, title, empty }) => {
        const found = plan.sections[key].map((id) => byId.get(id)).filter((o): o is Observation => !!o);
        const links = plan.links.filter((l) => l.section === key);
        return (
          <section key={key} aria-labelledby={`sec-${key}`} className="grid gap-2">
            <h2 id={`sec-${key}`} className="t-sub">
              {title}
            </h2>
            {found.length ? (
              <div className="cards">
                {found.map((o) => (
                  <PlanObservationCard key={o.id} o={o} now={now} />
                ))}
              </div>
            ) : (
              <p className="muted">{empty}</p>
            )}
            {links.length ? (
              <div className="row" aria-label={`${title} links`}>
                {links.map((l) => (
                  <a key={l.url} className="btn btn-sm" href={l.url} target="_blank" rel="noopener noreferrer">
                    {l.label}
                  </a>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}

      <section aria-labelledby="loco" className="fieldset">
        <h2 id="loco" className="t-sub">
          Send to Loco
        </h2>
        <p className="muted t-caption">
          Ask Claude: “send Rumbo plan {plan.id} to Loco”. Or copy this proposal into Loco&apos;s <code>loco_propose</code>.
        </p>
        <pre className="table-wrap t-caption" tabIndex={0} aria-label="Loco proposal JSON">
          {proposal}
        </pre>
        <div className="row">
          <CopyButton text={proposal} label="Copy JSON" />
        </div>
      </section>
    </>
  );
}

export default async function PlanDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; change?: string }> }) {
  const [{ id }, { error, change }] = await Promise.all([params, searchParams]);
  const plan = getPlan(OWNER, id);
  if (!plan) notFound();
  const now = new Date();
  const choosing = plan.status === "choosing" || !plan.chosen || change === "1";
  return (
    <>
      <div>
        <p className="t-caption">
          <Link href="/plan">All plans</Link>
        </p>
        <h1 className="t-title">{plan.chosen ?? "Choose a place"}</h1>
        <p className="muted">
          {plan.dates ? `${formatDay(plan.dates.from)} to ${formatDay(plan.dates.to)}` : plan.request.text ?? ""}
          {plan.status === "archived" ? " · archived" : ""}
          {plan.status === "sent-to-loco" ? " · sent to Loco" : ""}
        </p>
        {plan.status === "ready" ? <p className="muted t-caption">In Loco, open a trip and tap Plan with Rumbo to add this plan as a proposal.</p> : null}
        {plan.request.text && plan.dates ? <p className="muted t-caption">“{plan.request.text}”</p> : null}
        {plan.chosen && !choosing && plan.status !== "archived" ? (
          <p className="t-caption">
            <Link href={`/plan/${plan.id}?change=1`}>Choose another place</Link>
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      {choosing ? <Choosing plan={plan} now={now} /> : <Planned plan={plan} now={now} />}
      <Notices id={plan.id} />
      {plan.status !== "archived" ? (
        <form action={archivePlanAction}>
          <input type="hidden" name="id" value={plan.id} />
          <button type="submit" className="btn btn-sm btn-danger">
            Archive this plan
          </button>
        </form>
      ) : null}
    </>
  );
}
