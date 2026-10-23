import Link from "next/link";
import { FeedCard } from "../../components/FeedCard";
import { getFeed } from "../../src/server/feed";
import { withWhy } from "../../src/server/feed-why";
import { KIND_FILTERS, parseKindParam } from "../../src/server/feed-ui";
import { OWNER, store } from "../../src/server/store";

export const dynamic = "force-dynamic";

export default async function FeedPage({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  const kind = parseKindParam((await searchParams).kind);
  const now = new Date();
  const hasProfile = !!store().getProfile();
  const items = hasProfile ? await withWhy(getFeed(OWNER, { kinds: kind ? [kind] : undefined, now }), { now }) : [];
  return (
    <>
      <div>
        <h1 className="t-title">Feed</h1>
        <p className="muted">Ranked for you by deal, fit, taste, urgency and novelty. Prices are sightings from the source shown; check the page before you book.</p>
      </div>

      <nav aria-label="Filter by kind" className="filters">
        <Link href="/" aria-current={kind ? undefined : "true"}>
          All
        </Link>
        {KIND_FILTERS.map((k) => (
          <Link key={k} href={`/?kind=${k}`} aria-current={kind === k ? "true" : undefined}>
            {k}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <div className="empty">
          {!hasProfile ? (
            <>
              <p>Rumbo ranks for someone, so it needs your profile first.</p>
              <p className="t-caption">
                <Link href="/profile">Fill in your profile</Link>, then start a trip in <Link href="/plan">Plan</Link> or connect an AI tool in <Link href="/agents">Agents</Link>.
              </p>
            </>
          ) : kind ? (
            <>
              <p>No {kind} items in the feed.</p>
              <p className="t-caption">
                <Link href="/">Show all kinds</Link>, or add a <Link href="/watches">watch</Link> for it.
              </p>
            </>
          ) : (
            <>
              <p>Nothing in the feed yet.</p>
              <p className="t-caption">
                <Link href="/plan">Plan a trip</Link> to see live fares, check your <Link href="/profile">profile</Link> (home airports, interests, free windows), or let an agent post what it finds from <Link href="/agents">Agents</Link>.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="cards">
          {items.map((item) => (
            <FeedCard key={item.observation.id} item={item} now={now} />
          ))}
        </div>
      )}
    </>
  );
}
