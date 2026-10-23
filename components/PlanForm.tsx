"use client";

import { useActionState } from "react";
import { startPlanAction } from "../app/(app)/plan/actions";
import type { FormState } from "../app/(app)/profile/actions";
import { INTERESTS } from "../src/core/schema";

const INITIAL: FormState = { ok: false, message: "" };

export function PlanForm({ currency }: { currency: string }) {
  const [state, action, pending] = useActionState(startPlanAction, INITIAL);
  return (
    <form action={action} className="form" aria-labelledby="describe-trip">
      <div className="field">
        <label htmlFor="text" id="describe-trip" className="t-sub">
          Describe the trip
        </label>
        <textarea
          id="text"
          name="text"
          rows={3}
          maxLength={1000}
          placeholder="4 days of kitesurf in March, under €600, with my wife"
        />
        <span className="hint">English, Spanish or Russian. Dates, length, budget, who goes, what you like. Leave out what you do not know.</span>
      </div>

      <details className="fieldset">
        <summary>Or fill in the details</summary>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="window_from">Trip may start from</label>
            <input id="window_from" name="window_from" type="date" />
          </div>
          <div className="field">
            <label htmlFor="window_to">and must end by</label>
            <input id="window_to" name="window_to" type="date" />
          </div>
          <div className="field">
            <label htmlFor="nights_min">Nights, at least</label>
            <input id="nights_min" name="nights_min" type="number" min={1} />
          </div>
          <div className="field">
            <label htmlFor="nights_max">Nights, at most</label>
            <input id="nights_max" name="nights_max" type="number" min={1} />
          </div>
          <div className="field">
            <label htmlFor="adults">Adults</label>
            <input id="adults" name="adults" type="number" min={1} placeholder="Your profile" />
          </div>
          <div className="field">
            <label htmlFor="children">Children</label>
            <input id="children" name="children" type="number" min={0} placeholder="Your profile" />
          </div>
          <div className="field">
            <label htmlFor="budget">Total budget ({currency})</label>
            <input id="budget" name="budget" type="number" min={0} step="any" />
          </div>
          <div className="field">
            <label htmlFor="destination">I know where</label>
            <input id="destination" name="destination" type="text" placeholder="Lisbon, or leave empty" autoComplete="off" />
          </div>
        </div>
        <div className="field">
          <span className="label">Interests</span>
          <div className="row">
            {INTERESTS.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" name="interest" value={k} /> {k}
              </label>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" name="car" /> I need a rental car
        </label>
      </details>

      {state.message ? (
        <p role={state.ok ? "status" : "alert"} className={`notice ${state.ok ? "notice-ok" : "notice-error"}`}>
          {state.message}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Planning… this can take 20 seconds" : "Plan this trip"}
        </button>
      </div>
    </form>
  );
}
