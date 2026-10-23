import type { Metadata } from "next";
import { WatchForm } from "../../../components/WatchForm";
import { formatDay, formatMoney, formatStamp } from "../../../components/format";
import { store } from "../../../src/server/store";
import { deleteWatchAction, toggleWatchAction } from "./actions";

export const metadata: Metadata = { title: "Watches" };
export const dynamic = "force-dynamic";

export default function WatchesPage() {
  const s = store();
  const watches = s.listWatches();
  const currency = s.getProfile()?.currency ?? "EUR";
  return (
    <>
      <div>
        <h1 className="t-title">Watches</h1>
        <p className="muted">What the server keeps checking. Findings land in the feed.</p>
      </div>

      {watches.length === 0 ? (
        <div className="empty">No watches yet. Add one below.</div>
      ) : (
        <div className="cards">
          {watches.map((w) => (
            <article key={w.id} className="card" aria-label={w.label}>
              <div className="row row-between">
                <span className="chip">{w.kind}</span>
                <span className={`chip ${w.active ? "chip-good" : ""}`}>{w.active ? "active" : "paused"}</span>
              </div>
              <h2 className="t-sub">{w.label}</h2>
              <p className="t-caption">
                {w.kind === "route"
                  ? `${w.origin.join(", ") || "home airports"} to ${w.destination.join(", ")}`
                  : w.place
                    ? w.place
                    : `from ${w.origin.join(", ") || "home airports"}`}
                {" · "}
                {formatDay(w.window.from)} to {formatDay(w.window.to)}
                {w.nights ? ` · ${w.nights.min}-${w.nights.max} nights` : ""}
              </p>
              <p className="muted t-caption">
                Every {w.every_hours} h{w.max_price ? ` · alert under ${formatMoney(w.max_price)}` : ""}
                {w.last_run_at ? ` · last run ${formatStamp(w.last_run_at)}` : " · not run yet"}
                {w.created_by !== "owner" ? ` · proposed by ${w.created_by}` : ""}
              </p>
              <div className="row">
                <form action={toggleWatchAction}>
                  <input type="hidden" name="id" value={w.id} />
                  <button type="submit" className="btn btn-sm">
                    {w.active ? "Pause" : "Resume"}
                  </button>
                </form>
                <form action={deleteWatchAction}>
                  <input type="hidden" name="id" value={w.id} />
                  <button type="submit" className="btn btn-sm btn-danger">
                    Delete
                  </button>
                </form>
              </div>
            </article>
          ))}
        </div>
      )}

      <WatchForm currency={currency} />
    </>
  );
}
