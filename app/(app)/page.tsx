import Link from "next/link";
import { ObservationCard } from "../../components/ObservationCard";
import { store } from "../../src/server/store";

export const dynamic = "force-dynamic";

/** Temporary feed: newest observations first. The plan-feed lane replaces the order with the ranker. */
export default function FeedPage() {
  const now = new Date();
  const items = store().listStoredObservations({ limit: 60, now });
  return (
    <>
      <div>
        <h1 className="t-title">Feed</h1>
        <p className="muted">Newest first. Ranking by your profile arrives with the plan and feed lane.</p>
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <p>Nothing here yet.</p>
          <p className="t-caption">
            Add a <Link href="/watches">watch</Link> so the server keeps checking, or let an agent post observations to <code>/api/v1/observations</code>.
          </p>
        </div>
      ) : (
        <div className="cards">
          {items.map((item) => (
            <ObservationCard key={item.observation.id} item={item} now={now} />
          ))}
        </div>
      )}
    </>
  );
}
