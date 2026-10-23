import type { Metadata } from "next";
import Link from "next/link";
import { PlanForm } from "../../../components/PlanForm";
import { formatDay } from "../../../components/format";
import { OWNER, store } from "../../../src/server/store";
import { listPlans } from "../../../src/server/plan";

export const metadata: Metadata = { title: "Plan" };
export const dynamic = "force-dynamic";

export default function PlanPage() {
  const profile = store().getProfile();
  const plans = listPlans(OWNER).filter((p) => p.status !== "archived");
  return (
    <>
      <div>
        <h1 className="t-title">Plan</h1>
        <p className="muted">Start a trip from one sentence. Rumbo suggests places, finds live fares, then fills flights, stay, car, activities and events.</p>
      </div>

      {profile ? (
        <PlanForm currency={profile.currency} />
      ) : (
        <p className="notice">
          Rumbo needs your home airports first. <Link href="/profile">Fill in your profile</Link>.
        </p>
      )}

      <section aria-labelledby="past-plans" className="grid gap-2">
        <h2 id="past-plans" className="t-sub">
          Your plans
        </h2>
        {plans.length === 0 ? (
          <div className="empty">No plans yet.</div>
        ) : (
          <ul className="grid gap-2">
            {plans.map((p) => (
              <li key={p.id}>
                <Link href={`/plan/${p.id}`} className="card">
                  <span className="t-sub">{p.chosen ?? p.request.destination ?? p.request.text ?? "Untitled plan"}</span>
                  <span className="muted t-caption">
                    {p.status === "choosing" ? "choose a place" : p.status} ·{" "}
                    {p.dates ? `${formatDay(p.dates.from)} to ${formatDay(p.dates.to)}` : `${formatDay(p.request.window.from)} to ${formatDay(p.request.window.to)}`}
                    {p.request.text && p.chosen ? ` · ${p.request.text.slice(0, 80)}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
