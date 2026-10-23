import type { Observation } from "../src/core/schema";
import { formatMoney, formatStamp, isStale, observationFacts, observationPrice } from "./format";

/** One ranked offer inside a plan section: price from minor units, source, seen time, stale badge, book link. */
export function PlanObservationCard({ o, now }: { o: Observation; now: Date }) {
  const price = observationPrice(o);
  const stale = isStale(o.provenance.expires_at, now);
  const link = o.book_url ?? o.provenance.url;
  return (
    <article className="card" aria-label={o.title}>
      <div className="row row-between">
        <span className="chip">{o.provenance.source}</span>
        {stale ? <span className="chip chip-warn">stale: check before booking</span> : null}
      </div>
      <h3 className="t-sub">{o.title}</h3>
      {price ? <p className="price num">{o.kind === "event" ? "from " : ""}{formatMoney(price)}{o.kind === "flight" ? " per person" : ""}</p> : null}
      <p className="t-caption">{observationFacts(o)}</p>
      <p className="muted t-caption">seen {formatStamp(o.provenance.seen_at, now)}</p>
      {link ? (
        <p>
          <a className="btn btn-sm" href={link} target="_blank" rel="noopener noreferrer">
            {o.book_url ? "Open booking page" : "Open source page"}
          </a>
        </p>
      ) : null}
    </article>
  );
}
