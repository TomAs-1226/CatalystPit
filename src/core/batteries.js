// The battery board: where each battery is, what it measured, and which one to take next.
//
// A battery moves round a loop — charging, ready, in the robot, resting, back on charge — and the
// two moments worth a measurement are the ends of a match: the resting voltage as it goes in, and
// again as it comes out. Everything this module recommends is worked out from readings somebody
// took. A battery nobody has measured is ranked last and said to be unmeasured; it is never given a
// voltage it was not seen to have.

import { nextId } from "./store.js";

export const STATES = ["charging", "ready", "in-robot", "resting", "retired"];

export const STATE_NAMES = {
  charging: "Charging",
  ready: "Ready",
  "in-robot": "In robot",
  resting: "Resting",
  retired: "Retired",
};

/**
 * Where a battery stops being trusted. These are this app's defaults, not a standard: a healthy
 * 12 V FRC battery rests near 12.7 to 13 V off the charger and measures roughly 11 to 15 mΩ. The
 * first two can be changed in Settings; the third is fixed.
 */
export const DEFAULT_LIMITS = {
  /** Rested below this, a "ready" battery is not actually full. */
  lowRestVolts: 12.5,
  /** At or above this internal resistance a battery sags under load and should not play a match. */
  weakMilliohm: 20,
  /** Came out of the robot below this: it was worked hard or went in short. Worth a look. */
  lowOutVolts: 11.7,
};

/** Two voltages closer than this are the same reading as far as a ranking is concerned. */
const VOLT_STEP = 0.05;

const find = (state, id) => state.batteries.find((b) => b.id === id) || null;

export function byId(state, id) {
  return find(state, id);
}

const cleanLabel = (label) => (typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "");

/** Add a battery by the label written on it. Refuses a blank label or one already on the board. */
export function addBattery(state, label, now) {
  const value = cleanLabel(label);
  if (!value) return { error: "Give the battery the label written on it." };
  if (state.batteries.some((b) => b.label.toLowerCase() === value.toLowerCase())) {
    return { error: `There is already a battery labelled ${value}.` };
  }
  const battery = {
    id: nextId(state, "b"),
    label: value,
    // New to the board means unknown, and the honest unknown is "resting": not claimed charged.
    state: "resting",
    stateSince: now,
    chargeSince: null,
    cycles: 0,
    note: "",
    readings: [],
  };
  state.batteries.push(battery);
  return { battery };
}

export function renameBattery(state, id, label) {
  const battery = find(state, id);
  const value = cleanLabel(label);
  if (!battery) return { error: "No such battery." };
  if (!value) return { error: "Give the battery the label written on it." };
  if (state.batteries.some((b) => b.id !== id && b.label.toLowerCase() === value.toLowerCase())) {
    return { error: `There is already a battery labelled ${value}.` };
  }
  battery.label = value;
  return { battery };
}

/** Remove a battery from the board altogether. Its readings go with it. */
export function removeBattery(state, id) {
  const before = state.batteries.length;
  state.batteries = state.batteries.filter((b) => b.id !== id);
  for (const entry of Object.values(state.log)) if (entry.batteryId === id) entry.batteryId = null;
  return state.batteries.length < before;
}

function reading(battery, kind, { volts = null, mohm = null, matchId = null } = {}, now) {
  const v = Number.isFinite(volts) ? volts : null;
  const r = Number.isFinite(mohm) ? mohm : null;
  if (v === null && r === null) return null;
  const entry = { at: now, kind, volts: v, mohm: r, matchId: matchId || null };
  battery.readings.push(entry);
  return entry;
}

function setState(battery, state, now) {
  battery.state = state;
  battery.stateSince = now;
}

/** The battery in the robot now, or null. There is only ever one. */
export function inRobot(state) {
  return state.batteries.find((b) => b.state === "in-robot") || null;
}

/**
 * Put a battery in the robot. One cycle is counted here, at the moment it goes in, because that is
 * the event that wears a battery. Refused while another is still marked in the robot: taking that
 * one out is its own step, with its own reading.
 */
export function putInRobot(state, id, measured, now) {
  const battery = find(state, id);
  if (!battery) return { error: "No such battery." };
  if (battery.state === "retired") return { error: `${battery.label} is retired.` };
  const current = inRobot(state);
  if (current && current.id !== id) return { error: `${current.label} is still marked in the robot. Take it out first.` };
  if (current && current.id === id) return { error: `${battery.label} is already in the robot.` };

  reading(battery, "in", measured, now);
  setState(battery, "in-robot", now);
  battery.cycles += 1;
  battery.chargeSince = null;
  if (measured?.matchId) (state.log[measured.matchId] ??= { batteryId: null, notes: "" }).batteryId = id;
  return { battery };
}

/** Take the battery out of the robot. It rests; it is not on charge until someone puts it there. */
export function takeOut(state, id, measured, now) {
  const battery = find(state, id);
  if (!battery) return { error: "No such battery." };
  if (battery.state !== "in-robot") return { error: `${battery.label} is not in the robot.` };
  // The out-reading belongs to the same match the in-reading did.
  const lastIn = [...battery.readings].reverse().find((r) => r.kind === "in");
  const matchId = measured?.matchId ?? lastIn?.matchId ?? matchUsing(state, id);
  reading(battery, "out", { ...measured, matchId }, now);
  setState(battery, "resting", now);
  return { battery };
}

function matchUsing(state, batteryId) {
  const hit = Object.entries(state.log).reverse().find(([, entry]) => entry.batteryId === batteryId);
  return hit ? hit[0] : null;
}

export function putOnCharge(state, id, now) {
  const battery = find(state, id);
  if (!battery) return { error: "No such battery." };
  if (battery.state === "in-robot") return { error: `${battery.label} is in the robot. Take it out first.` };
  if (battery.state === "retired") return { error: `${battery.label} is retired.` };
  // Going from ready back to charging is the same charge continuing, not a new one.
  if (battery.state !== "charging" && battery.state !== "ready") battery.chargeSince = now;
  if (battery.chargeSince === null) battery.chargeSince = now;
  setState(battery, "charging", now);
  return { battery };
}

/** Mark a battery charged and ready, with the resting voltage if one was taken. */
export function markReady(state, id, measured, now) {
  const battery = find(state, id);
  if (!battery) return { error: "No such battery." };
  if (battery.state === "in-robot") return { error: `${battery.label} is in the robot.` };
  if (battery.state === "retired") return { error: `${battery.label} is retired.` };
  reading(battery, "rest", measured, now);
  setState(battery, "ready", now);
  return { battery };
}

/** Log a resting measurement without moving the battery anywhere. */
export function logRest(state, id, measured, now) {
  const battery = find(state, id);
  if (!battery) return { error: "No such battery." };
  const entry = reading(battery, "rest", measured, now);
  if (!entry) return { error: "Enter a voltage or a resistance." };
  return { battery };
}

export function retire(state, id, now) {
  const battery = find(state, id);
  if (!battery) return { error: "No such battery." };
  if (battery.state === "in-robot") return { error: `${battery.label} is in the robot. Take it out first.` };
  setState(battery, "retired", now);
  battery.chargeSince = null;
  return { battery };
}

export function unretire(state, id, now) {
  const battery = find(state, id);
  if (!battery || battery.state !== "retired") return { error: "That battery is not retired." };
  setState(battery, "resting", now);
  return { battery };
}

// ---- reading the board -------------------------------------------------------------------------

const lastWhere = (battery, test) => {
  for (let i = battery.readings.length - 1; i >= 0; i--) if (test(battery.readings[i])) return battery.readings[i];
  return null;
};

/**
 * The resting voltage that describes the battery as it is now: the newest resting reading taken
 * since it last came out of the robot. One from before its last match describes a charge that has
 * since been used, and is not offered.
 */
export function restedVolts(battery) {
  const lastOut = lastWhere(battery, (r) => r.kind === "out");
  const rest = lastWhere(battery, (r) => r.kind === "rest" && r.volts !== null);
  if (!rest) return null;
  if (lastOut && lastOut.at > rest.at) return null;
  return rest.volts;
}

/** The newest internal resistance anyone measured, whenever that was. Resistance changes slowly. */
export function lastMilliohm(battery) {
  return lastWhere(battery, (r) => r.mohm !== null)?.mohm ?? null;
}

export function lastReading(battery, kind) {
  return lastWhere(battery, (r) => r.kind === kind);
}

/** How long it has been on charge, in milliseconds, or null when it is not known to be. */
export function chargeTime(battery, now) {
  if (battery.chargeSince === null) return null;
  if (battery.state !== "charging" && battery.state !== "ready") return null;
  return Math.max(0, now - battery.chargeSince);
}

/**
 * What is wrong with a battery, if anything. Each flag has a level and the words to show:
 *   weak   it should not play a match
 *   watch  it is worth a second look
 */
export function flags(battery, limits = DEFAULT_LIMITS) {
  const out = [];
  if (battery.state === "retired") return out;

  const mohm = lastMilliohm(battery);
  if (mohm !== null && mohm >= limits.weakMilliohm) {
    out.push({ id: "resistance", level: "weak", text: `Internal resistance ${Number(mohm.toFixed(1))} mΩ` });
  }

  const rest = restedVolts(battery);
  // Only once it is called ready: a low reading part way through a charge is just a charge part way.
  if (rest !== null && rest < limits.lowRestVolts && battery.state === "ready") {
    out.push({ id: "rest", level: "weak", text: `Rests at only ${rest.toFixed(2)} V` });
  }

  const lastOut = lastReading(battery, "out");
  const sinceOut = lastOut && !battery.readings.some((r) => r.kind === "in" && r.at > lastOut.at);
  if (sinceOut && lastOut.volts !== null && lastOut.volts < limits.lowOutVolts) {
    out.push({ id: "out", level: "watch", text: `Came out at ${lastOut.volts.toFixed(2)} V` });
  }
  return out;
}

export const isWeak = (battery, limits) => flags(battery, limits).some((f) => f.level === "weak");

/**
 * Rank the batteries that could go in next and pick the first.
 *
 * Order, each rule only breaking ties in the one before:
 *   1. not flagged weak
 *   2. marked ready, ahead of still charging
 *   3. a measured resting voltage, highest first (readings within 0.05 V count as equal)
 *   4. longest on charge
 *   5. fewest cycles, then label
 *
 * Batteries in the robot, resting or retired are not candidates. The result says why the pick won,
 * in words taken from its own readings, and says so when the pick is only the least bad.
 */
export function recommend(state, now, limits = DEFAULT_LIMITS) {
  const candidates = state.batteries
    .filter((b) => b.state === "ready" || b.state === "charging")
    .map((battery) => ({
      battery,
      weak: isWeak(battery, limits),
      rest: restedVolts(battery),
      charge: chargeTime(battery, now),
      flags: flags(battery, limits),
    }));

  const bucket = (v) => Math.round(v / VOLT_STEP);
  candidates.sort((a, b) => {
    if (a.weak !== b.weak) return a.weak ? 1 : -1;
    const ready = (x) => (x.battery.state === "ready" ? 0 : 1);
    if (ready(a) !== ready(b)) return ready(a) - ready(b);
    if ((a.rest === null) !== (b.rest === null)) return a.rest === null ? 1 : -1;
    if (a.rest !== null && bucket(a.rest) !== bucket(b.rest)) return bucket(b.rest) - bucket(a.rest);
    if ((a.charge === null) !== (b.charge === null)) return a.charge === null ? 1 : -1;
    if (a.charge !== null && a.charge !== b.charge) return b.charge - a.charge;
    if (a.battery.cycles !== b.battery.cycles) return a.battery.cycles - b.battery.cycles;
    return a.battery.label.localeCompare(b.battery.label, undefined, { numeric: true });
  });

  if (!candidates.length) {
    const active = state.batteries.filter((b) => b.state !== "retired");
    const reason = !state.batteries.length
      ? "No batteries on the board yet."
      : !active.length
        ? "Every battery is retired."
        : "Nothing is charging or ready. Put a battery on charge.";
    return { pick: null, ranked: [], reason, caution: null };
  }

  const pick = candidates[0];
  const why = [];
  why.push(pick.battery.state === "ready" ? "ready" : "still charging");
  if (pick.rest !== null) why.push(`${pick.rest.toFixed(2)} V rested`);
  else why.push("no resting voltage logged");
  if (pick.charge !== null) why.push(`${minutes(pick.charge)} on charge`);

  let caution = null;
  if (pick.weak) caution = "Every available battery is flagged. This is the least bad.";
  else if (pick.battery.state !== "ready") caution = "Nothing is marked ready yet.";
  else if (pick.rest === null) caution = "Not measured since it was charged.";

  return { pick, ranked: candidates, reason: why.join(" · "), caution };
}

function minutes(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/** The board's order: in the robot, then the candidates as ranked, then resting, then retired. */
export function boardOrder(state, now, limits = DEFAULT_LIMITS) {
  const ranked = recommend(state, now, limits).ranked.map((c) => c.battery);
  const rank = (b) => {
    if (b.state === "in-robot") return 0;
    if (b.state === "ready" || b.state === "charging") return 1;
    if (b.state === "resting") return 2;
    return 3;
  };
  return [...state.batteries].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 1) return ranked.indexOf(a) - ranked.indexOf(b);
    return a.label.localeCompare(b.label, undefined, { numeric: true });
  });
}
