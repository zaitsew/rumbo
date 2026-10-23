import type { Metadata } from "next";
import { formatDay } from "../../../components/format";
import { store } from "../../../src/server/store";

export const metadata: Metadata = { title: "Plan" };
export const dynamic = "force-dynamic";

/** Placeholder: the plan-feed lane replaces this page with the planner. */
export default function PlanPage() {
  const plans = store().listPlans();
  return (
    <>
      <div>
        <h1 className="t-title">Plan</h1>
        <p className="muted">Starting a trip from one sentence is coming. Saved plans show here.</p>
      </div>
      {plans.length === 0 ? (
        <div className="empty">No plans yet.</div>
      ) : (
        <ul className="grid gap-2">
          {plans.map((p) => (
            <li key={p.id} className="card">
              <span className="t-sub">{p.chosen ?? p.request.text ?? "Untitled plan"}</span>
              <span className="muted t-caption">
                {p.status} · {formatDay(p.request.window.from)} to {formatDay(p.request.window.to)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
