import type { FeedItem } from "../src/core/schema";
import { FeedActions } from "./FeedActions";
import { formatMoney, formatStamp, isStale, observationFacts, observationPrice } from "./format";

/** One ranked item: facts, price with its source and link, why it ranks here, and the feedback buttons. */
export function FeedCard({ item, now }: { item: FeedItem; now: Date }) {
  const o = item.observation;
  const price = observationPrice(o);
  const stale = item.stale || isStale(o.provenance.expires_at, now);
  const source = o.provenance.url ? (
    <a href={o.provenance.url} target="_blank" rel="noopener noreferrer">
      {o.provenance.source}
    </a>
  ) : (
    o.provenance.source
  );
  return (
    <article className="card" aria-label={o.title}>
      <div className="row row-between">
        <span className="chip">{o.kind}</span>
        <span className="row">
          {item.state !== "new" ? <span className="chip">{item.state}</span> : null}
          {stale ? <span className="chip chip-warn">stale: check before booking</span> : null}
          <span className="chip" title="Score from Rumbo's ranker, 0 to 100">
            score {Math.round(item.score * 100)}
          </span>
        </span>
      </div>
      <h2 className="t-sub">{o.title}</h2>
      <p className="muted t-caption">
        {o.place}
        {o.country ? `, ${o.country}` : ""}
      </p>
      <p className="t-caption">{observationFacts(o)}</p>
      {price ? (
        <p>
          <span className="price num">
            {o.kind === "event" ? "from " : ""}
            {formatMoney(price)}
          </span>
          {o.kind === "flight" ? <span className="t-caption"> per person</span> : null}
          <br />
          <span className="muted t-caption">
            {source} · seen {formatStamp(o.provenance.seen_at, now)}
            {o.provenance.agent ? ` · via ${o.provenance.agent}` : ""}
          </span>
        </p>
      ) : (
        <p className="muted t-caption">
          {source} · seen {formatStamp(o.provenance.seen_at, now)}
        </p>
      )}
      {item.why ? (
        <p className="feed-why">
          <span className="chip" title="Written by an AI from the reasons below; it adds no numbers">
            AI
          </span>{" "}
          {item.why}
        </p>
      ) : null}
      {item.reasons.length ? (
        <ul className="t-caption feed-reasons" aria-label="Why it ranks here">
          {item.reasons.slice(0, 5).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        {o.book_url ? (
          <a className="btn btn-sm btn-primary" href={o.book_url} target="_blank" rel="noopener noreferrer">
            Open booking page
          </a>
        ) : null}
      </div>
      <FeedActions observationId={o.id} title={o.title} />
    </article>
  );
}
