import type { StoredObservation } from "../src/server/store";
import { formatMoney, formatStamp, isStale, observationFacts, observationPrice } from "./format";

export function ObservationCard({ item, now }: { item: StoredObservation; now: Date }) {
  const o = item.observation;
  const price = observationPrice(o);
  const stale = isStale(item.expires_at, now);
  return (
    <article className="card" aria-label={o.title}>
      <div className="row row-between">
        <span className="chip">{o.kind}</span>
        {stale ? <span className="chip chip-warn">stale</span> : null}
      </div>
      <h2 className="t-sub">{o.title}</h2>
      <p className="muted t-caption">
        {o.place}
        {o.country ? `, ${o.country}` : ""}
      </p>
      {price ? <p className="price num">{formatMoney(price)}</p> : null}
      <p className="t-caption">{observationFacts(o)}</p>
      <p className="muted t-caption">
        {o.provenance.source} · seen {formatStamp(item.seen_at, now)}
        {item.expires_at ? ` · ${stale ? "expired" : "expires"} ${formatStamp(item.expires_at, now)}` : ""}
      </p>
      {o.book_url ? (
        <p>
          <a className="btn btn-sm" href={o.book_url} target="_blank" rel="noopener noreferrer">
            Open booking page
          </a>
        </p>
      ) : null}
    </article>
  );
}
