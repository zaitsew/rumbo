"use client";

import { useActionState, useState } from "react";
import { addWatchAction } from "../app/(app)/watches/actions";
import type { FormState } from "../app/(app)/profile/actions";

const INITIAL: FormState = { ok: false, message: "" };
const KINDS = [
  { value: "route", label: "Route (airports to airports)" },
  { value: "anywhere", label: "Anywhere (cheapest from home)" },
  { value: "place-events", label: "Events in a city" },
  { value: "place-stays", label: "Stays in a city" },
  { value: "place-activities", label: "Activities in a city" },
] as const;

export function WatchForm({ currency }: { currency: string }) {
  const [state, action, pending] = useActionState(addWatchAction, INITIAL);
  const [kind, setKind] = useState<string>("route");
  const isPlace = kind.startsWith("place-");

  return (
    <form action={action} className="form fieldset" aria-labelledby="add-watch">
      <h2 id="add-watch" className="t-sub">
        Add a watch
      </h2>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="kind">Kind</label>
          <select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="label">Label</label>
          <input id="label" name="label" type="text" placeholder="Optional" />
        </div>
        {!isPlace ? (
          <div className="field">
            <label htmlFor="origin">From airports</label>
            <input id="origin" name="origin" type="text" placeholder="Empty means your home airports" />
          </div>
        ) : null}
        {kind === "route" ? (
          <div className="field">
            <label htmlFor="destination">To airports</label>
            <input id="destination" name="destination" type="text" placeholder="LIS, OPO" required />
          </div>
        ) : null}
        {isPlace ? (
          <div className="field">
            <label htmlFor="place">City</label>
            <input id="place" name="place" type="text" placeholder="Lisbon" required />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="window_from">{isPlace ? "Dates from" : "Depart from"}</label>
          <input id="window_from" name="window_from" type="date" required />
        </div>
        <div className="field">
          <label htmlFor="window_to">{isPlace ? "Dates to" : "Depart until"}</label>
          <input id="window_to" name="window_to" type="date" required />
        </div>
        {!isPlace ? (
          <>
            <div className="field">
              <label htmlFor="nights_min">Nights, at least</label>
              <input id="nights_min" name="nights_min" type="number" min={0} />
            </div>
            <div className="field">
              <label htmlFor="nights_max">Nights, at most</label>
              <input id="nights_max" name="nights_max" type="number" min={0} />
            </div>
          </>
        ) : null}
        <div className="field">
          <label htmlFor="max_price">Alert under ({currency})</label>
          <input id="max_price" name="max_price" type="number" min={0} step="any" />
        </div>
        <div className="field">
          <label htmlFor="every_hours">Check every (hours)</label>
          <input id="every_hours" name="every_hours" type="number" min={1} defaultValue={24} />
        </div>
      </div>
      {state.message ? (
        <p role={state.ok ? "status" : "alert"} className={`notice ${state.ok ? "notice-ok" : "notice-error"}`}>
          {state.message}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Adding…" : "Add watch"}
        </button>
      </div>
    </form>
  );
}
