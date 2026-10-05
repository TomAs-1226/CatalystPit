// The shape of an event on disk, and how an older file becomes the current one.
//
// One JSON file holds one event: the checklist and its runs, the batteries, the schedule, the match
// log and the issues. Rust writes it atomically and knows nothing about what is inside; everything
// about the shape lives here, where it can be tested with `node --test`.
//
// The rule a migration answers to: a pit crew's notes are not ours to lose. A file from a newer
// build is refused untouched rather than "repaired", a file that is not an object is refused rather
// than replaced, and a current file with pieces missing has them filled in around what is there.

import { defaultGroups } from "./checklist.js";

/** Bumped whenever the shape changes in a way an older build would misread. */
export const SCHEMA = 1;

/** A new, empty event. Nothing in it is invented: no batteries, no matches, no history. */
export function defaults() {
  return {
    schema: SCHEMA,
    seq: 0,
    event: { name: "", startedAt: null },
    checklist: { groups: defaultGroups(), drafts: {}, history: [] },
    batteries: [],
    schedule: [],
    log: {},
    issues: [],
    nexus: null,
  };
}

/** The next id for a thing of this kind: "b3", "i12". Counted in the file, so ids never repeat. */
export function nextId(state, prefix) {
  state.seq = (Number.isInteger(state.seq) ? state.seq : 0) + 1;
  return `${prefix}${state.seq}`;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const text = (v, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * Steps from one schema to the next, keyed by the version they start from. Each takes the raw
 * object and returns it one version on.
 *
 * 0 is a file with no `schema` field: one written by hand, or by a build from before the field
 * existed. It is the same shape as 1 as far as it goes, so the step only stamps it; `normalise`
 * below then fills in whatever it lacks.
 */
const STEPS = {
  0: (raw) => ({ ...raw, schema: 1 }),
};

/**
 * Turn whatever was read from disk into a current state.
 *
 * Returns `{ status, state, from }`:
 *   new       nothing on disk; `state` is an empty event
 *   ok        current schema, used as it is (after filling any gaps)
 *   migrated  an older schema, stepped forward; `from` is where it started
 *   newer     written by a newer build; `state` is null and nothing may be saved over it
 *   invalid   not an object at all; `state` is null, same rule
 */
export function migrate(raw) {
  if (raw === null || raw === undefined) return { status: "new", state: defaults(), from: null };
  if (!isObject(raw)) return { status: "invalid", state: null, from: null };

  const from = Number.isInteger(raw.schema) ? raw.schema : 0;
  if (from > SCHEMA) return { status: "newer", state: null, from };
  if (from < 0) return { status: "invalid", state: null, from };

  let current = raw;
  for (let v = from; v < SCHEMA; v++) {
    const step = STEPS[v];
    if (!step) return { status: "invalid", state: null, from };
    current = step(current);
  }
  return { status: from === SCHEMA ? "ok" : "migrated", state: normalise(current), from };
}

/**
 * Fill in what is missing and drop what cannot be used, without touching anything that is sound.
 * Every list entry that survives has the fields the rest of the app reads without checking.
 */
export function normalise(raw) {
  const base = defaults();
  const state = {
    schema: SCHEMA,
    seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
    event: {
      name: text(raw.event?.name),
      startedAt: num(raw.event?.startedAt),
    },
    checklist: normaliseChecklist(raw.checklist, base.checklist),
    batteries: list(raw.batteries).filter(isObject).filter((b) => text(b.id) && text(b.label)).map(normaliseBattery),
    schedule: list(raw.schedule).filter(isObject).filter((m) => text(m.id) && text(m.label)).map(normaliseMatch),
    log: {},
    issues: list(raw.issues).filter(isObject).filter((i) => text(i.id) && text(i.title)).map(normaliseIssue),
    nexus: isObject(raw.nexus) ? normaliseNexus(raw.nexus) : null,
  };

  if (isObject(raw.log)) {
    for (const [matchId, entry] of Object.entries(raw.log)) {
      if (!isObject(entry)) continue;
      state.log[matchId] = { batteryId: text(entry.batteryId) || null, notes: text(entry.notes) };
    }
  }

  // Ids are handed out from `seq`. A file whose counter is behind its own ids — edited by hand, or
  // merged from two laptops — would hand out one that is already taken.
  let highest = state.seq;
  const seen = (id) => {
    // Only ids this counter made ("b3", "i12"); the starting checklist's "mechanical-7" is not one.
    const m = /^[a-z](\d+)$/.exec(id);
    if (m) highest = Math.max(highest, Number(m[1]));
  };
  state.batteries.forEach((b) => seen(b.id));
  state.issues.forEach((i) => seen(i.id));
  state.checklist.history.forEach((h) => seen(h.id));
  state.checklist.groups.forEach((g) => { seen(g.id); g.items.forEach((i) => seen(i.id)); });
  state.seq = highest;

  return state;
}

function normaliseChecklist(raw, base) {
  if (!isObject(raw)) return base;
  const groups = Array.isArray(raw.groups)
    ? raw.groups.filter(isObject).filter((g) => text(g.id)).map((g) => ({
        id: g.id,
        name: text(g.name, "Untitled"),
        items: list(g.items).filter(isObject).filter((i) => text(i.id) && text(i.text)).map((i) => ({ id: i.id, text: i.text })),
      }))
    : base.groups;

  const drafts = {};
  if (isObject(raw.drafts)) {
    for (const [matchId, draft] of Object.entries(raw.drafts)) {
      if (!isObject(draft) || !isObject(draft.ticks)) continue;
      const ticks = {};
      for (const [itemId, at] of Object.entries(draft.ticks)) if (Number.isFinite(at)) ticks[itemId] = at;
      drafts[matchId] = { ticks };
    }
  }

  const history = list(raw.history).filter(isObject).filter((h) => text(h.id) && Number.isFinite(h.at)).map((h) => ({
    id: h.id,
    at: h.at,
    matchId: text(h.matchId) || null,
    matchLabel: text(h.matchLabel),
    total: Number.isInteger(h.total) ? h.total : 0,
    done: Number.isInteger(h.done) ? h.done : 0,
    missed: list(h.missed).filter(isObject).map((m) => ({ group: text(m.group), text: text(m.text) })),
  }));

  return { groups, drafts, history };
}

const BATTERY_STATES = ["charging", "ready", "in-robot", "resting", "retired"];

function normaliseBattery(b) {
  return {
    id: b.id,
    label: b.label,
    state: BATTERY_STATES.includes(b.state) ? b.state : "resting",
    stateSince: num(b.stateSince),
    chargeSince: num(b.chargeSince),
    cycles: Number.isInteger(b.cycles) && b.cycles >= 0 ? b.cycles : 0,
    note: text(b.note),
    readings: list(b.readings).filter(isObject).filter((r) => Number.isFinite(r.at)).map((r) => ({
      at: r.at,
      kind: ["in", "out", "rest"].includes(r.kind) ? r.kind : "rest",
      volts: num(r.volts),
      mohm: num(r.mohm),
      matchId: text(r.matchId) || null,
    })),
  };
}

function normaliseMatch(m) {
  const times = isObject(m.times) ? m.times : {};
  const teams = (v) => list(v).map((t) => String(t)).filter(Boolean);
  return {
    id: m.id,
    label: m.label,
    source: m.source === "nexus" ? "nexus" : "manual",
    status: text(m.status),
    alliance: m.alliance === "red" || m.alliance === "blue" ? m.alliance : null,
    red: teams(m.red),
    blue: teams(m.blue),
    times: {
      queue: num(times.queue),
      onDeck: num(times.onDeck),
      onField: num(times.onField),
      start: num(times.start),
      queueActual: times.queueActual === true,
      onFieldActual: times.onFieldActual === true,
    },
    played: m.played === true,
    playedAt: num(m.playedAt),
  };
}

function normaliseIssue(i) {
  return {
    id: i.id,
    title: i.title,
    detail: text(i.detail),
    severity: ["low", "medium", "high"].includes(i.severity) ? i.severity : "medium",
    state: i.state === "fixed" ? "fixed" : "open",
    openedAt: num(i.openedAt),
    matchId: text(i.matchId) || null,
    fixedAt: num(i.fixedAt),
    fixNote: text(i.fixNote),
  };
}

function normaliseNexus(n) {
  return {
    eventKey: text(n.eventKey),
    fetchedAt: num(n.fetchedAt),
    asOf: num(n.asOf),
    nowQueuing: text(n.nowQueuing),
    announcements: list(n.announcements).filter(isObject).map((a) => ({ text: text(a.text), at: num(a.at) })).filter((a) => a.text),
  };
}

/**
 * Start the next event from this one. The batteries and the checklist's items are the team's and
 * carry over; the schedule, the log, the runs and the issues belong to the event that is ending.
 * Open issues carry over too: a cracked intake plate is still cracked in a different city.
 */
export function nextEvent(state, name, now) {
  const fresh = defaults();
  fresh.seq = state.seq;
  fresh.event = { name: name.trim(), startedAt: now };
  fresh.checklist.groups = state.checklist.groups;
  fresh.batteries = state.batteries.map((b) => ({ ...b, readings: b.readings.map((r) => ({ ...r, matchId: null })) }));
  fresh.issues = state.issues.filter((i) => i.state === "open").map((i) => ({ ...i, matchId: null }));
  return fresh;
}
