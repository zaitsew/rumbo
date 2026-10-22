"use client";

import { useActionState, useState } from "react";
import { INTERESTS, type Interest, type Profile } from "../src/core/schema";
import { saveProfileAction, saveProfileJsonAction, type FormState } from "../app/(app)/profile/actions";
import { formatWindows } from "../src/server/forms";
import { toMajor } from "./format";

const INITIAL: FormState = { ok: false, message: "" };
const STAY_KINDS = ["hotel", "apartment", "hostel", "villa", "camping", "boutique"] as const;
const LEVELS: Record<number, string> = { [-2]: "avoid", [-1]: "rather not", 0: "neutral", 1: "like", 2: "love" };

/** A cheap content hash, so a saved profile remounts the uncontrolled form with the stored values. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h);
}

function Status({ state }: { state: FormState }) {
  if (!state.message) return null;
  return (
    <p role={state.ok ? "status" : "alert"} className={`notice ${state.ok ? "notice-ok" : "notice-error"}`}>
      {state.message}
    </p>
  );
}

function InterestSlider({ name, label, initial }: { name: Interest; label: string; initial: number }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="interest">
      <label htmlFor={`interest_${name}`}>{label}</label>
      <input
        id={`interest_${name}`}
        name={`interest_${name}`}
        type="range"
        min={-2}
        max={2}
        step={1}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        aria-valuetext={LEVELS[value]}
      />
      <span className="t-caption muted" aria-hidden="true">
        {LEVELS[value]}
      </span>
    </div>
  );
}

export function ProfileForm({ profile }: { profile: Profile | null }) {
  const [state, action, pending] = useActionState(saveProfileAction, INITIAL);
  const [jsonState, jsonAction, jsonPending] = useActionState(saveProfileJsonAction, INITIAL);
  const p = profile;
  const currency = p?.currency ?? "EUR";
  const money = (m?: { amount_minor: number; currency: string }) => (m ? toMajor(m.amount_minor, m.currency) : "");

  return (
    <div className="grid gap-6">
      {!p ? <p className="notice">No profile yet. Fill in the form, or seed one with <code>npm run seed-profile</code>.</p> : null}
      {/* key: a saved profile remounts the form with the stored values */}
      <form action={action} className="form" key={p ? hash(JSON.stringify(p)) : "new"}>
        <fieldset className="fieldset">
          <legend>You</legend>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" defaultValue={p?.name ?? ""} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="home_city">Home city</label>
              <input id="home_city" name="home_city" type="text" defaultValue={p?.home_city ?? ""} required />
            </div>
            <div className="field">
              <label htmlFor="home_airports">Home airports</label>
              <input id="home_airports" name="home_airports" type="text" defaultValue={p?.home_airports.join(", ") ?? ""} required placeholder="VLC, ALC, MAD" />
              <span className="hint">IATA codes, most preferred first.</span>
            </div>
            <div className="field">
              <label htmlFor="currency">Currency</label>
              <input id="currency" name="currency" type="text" defaultValue={currency} maxLength={3} required />
            </div>
            <div className="field">
              <label htmlFor="adults">Adults</label>
              <input id="adults" name="adults" type="number" min={1} defaultValue={p?.travellers.adults ?? 1} />
            </div>
            <div className="field">
              <label htmlFor="children">Children</label>
              <input id="children" name="children" type="number" min={0} defaultValue={p?.travellers.children ?? 0} />
            </div>
            <div className="field">
              <label htmlFor="languages">Languages</label>
              <input id="languages" name="languages" type="text" defaultValue={p?.languages.join(", ") ?? ""} placeholder="en, es" />
            </div>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Interests</legend>
          <p className="hint">From avoid to love. Neutral is the default and is not stored.</p>
          {INTERESTS.map((k) => (
            <InterestSlider key={k} name={k} label={k} initial={p?.interests[k] ?? 0} />
          ))}
        </fieldset>

        <fieldset className="fieldset">
          <legend>Budgets</legend>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="flight_max">Flight, per person, return ({currency})</label>
              <input id="flight_max" name="flight_max" type="number" min={0} step="any" defaultValue={money(p?.budget.flight_max)} />
            </div>
            <div className="field">
              <label htmlFor="night_max">Stay, per night, per room ({currency})</label>
              <input id="night_max" name="night_max" type="number" min={0} step="any" defaultValue={money(p?.budget.night_max)} />
            </div>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Flights</legend>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="max_stops">Most stops</label>
              <select id="max_stops" name="max_stops" defaultValue={String(p?.flight.max_stops ?? 1)}>
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Direct only" : n}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="max_hours_one_way">Longest one way (hours)</label>
              <input id="max_hours_one_way" name="max_hours_one_way" type="number" min={1} step="any" defaultValue={p?.flight.max_hours_one_way ?? 8} />
            </div>
            <div className="field">
              <label htmlFor="earliest_departure">Earliest departure</label>
              <input id="earliest_departure" name="earliest_departure" type="time" defaultValue={p?.flight.earliest_departure ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="preferred_airlines">Preferred airlines</label>
              <input id="preferred_airlines" name="preferred_airlines" type="text" defaultValue={p?.flight.preferred_airlines.join(", ") ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="avoid_airlines">Avoid airlines</label>
              <input id="avoid_airlines" name="avoid_airlines" type="text" defaultValue={p?.flight.avoid_airlines.join(", ") ?? ""} />
            </div>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Stays</legend>
          <div className="row">
            {STAY_KINDS.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" name="stay_kind" value={k} defaultChecked={p?.stay.kinds.includes(k)} />
                {k}
              </label>
            ))}
          </div>
          <div className="field">
            <label htmlFor="min_rating">Minimum rating (0 to 10)</label>
            <input id="min_rating" name="min_rating" type="number" min={0} max={10} step="0.1" defaultValue={p?.stay.min_rating ?? ""} />
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>When and where</legend>
          <div className="field">
            <label htmlFor="free_windows">Free windows</label>
            <textarea id="free_windows" name="free_windows" className="mono" defaultValue={p ? formatWindows(p.free_windows) : ""} placeholder={"2026-12-05 2026-12-09 puente"} />
            <span className="hint">One per line: start day, end day, optional note.</span>
          </div>
          <div className="field">
            <label htmlFor="wishlist">Wishlist</label>
            <textarea id="wishlist" name="wishlist" defaultValue={p?.wishlist.join("\n") ?? ""} placeholder={"Lisbon\nMadeira"} />
            <span className="hint">Places to go some day, one per line.</span>
          </div>
        </fieldset>

        <Status state={state} />
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>

      <details className="fieldset">
        <summary>Raw JSON</summary>
        <form action={jsonAction} className="form">
          <p className="hint">
            The whole profile, including the busy days and notes that agents add. Saving replaces it.
          </p>
          <textarea name="json" className="mono" rows={16} defaultValue={p ? JSON.stringify(p, null, 2) : "{\n  \"home_city\": \"\",\n  \"home_airports\": []\n}"} aria-label="Profile JSON" />
          <Status state={jsonState} />
          <div className="row">
            <button type="submit" className="btn" disabled={jsonPending}>
              {jsonPending ? "Saving…" : "Save JSON"}
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
