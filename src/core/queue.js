// The team's matches: where they come from, which is next, and how long until it.
//
// Two sources fill the same list. Nexus for FRC is the live one — it knows what the field is
// queuing and re-estimates every time as the event runs late. The other is someone typing the
// schedule in from the printout, which is what there is with no key or no network. A match is the
// same object either way, and every screen reads it the same way.
//
// The rule for anything shown as a time: it was either typed in or sent by Nexus. Nothing here
// derives a queue time from a start time, or guesses how late an event is running. When a queue time
// is not known the countdown is to the start, and it says so.

/** How long after a match took the field Nexus's copy of it is treated as played. */
const PLAYED_AFTER_ON_FIELD = 12 * 60 * 1000;

/** Nexus data older than this is called out as stale wherever a time from it is shown. */
export const STALE_AFTER = 3 * 60 * 1000;

const KINDS = [
  { key: "pr", short: "P", long: "Practice", order: 0, test: /^(?:practice|prac|pr|p)\s*#?\s*(\d+)/i },
  { key: "q", short: "Q", long: "Qualification", order: 1, test: /^(?:qualification|qualifier|quals?|qm|q)\s*#?\s*(\d+)/i },
  { key: "m", short: "M", long: "Playoff", order: 2, test: /^(?:playoffs?|elimination|elim|match|m)\s*#?\s*(\d+)/i },
  { key: "f", short: "F", long: "Final", order: 3, test: /^(?:finals?|f)\s*#?\s*(\d+)/i },
];

/**
 * Read a match label, however it was written. "Qualification 12", "Qual 12", "Q12" and "q 12" are
 * one match; so are Nexus's label for it and the one typed from the printout, which is what lets a
 * hand-entered schedule be taken over by Nexus later without doubling every row.
 */
export function readLabel(label) {
  const text = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "";
  for (const kind of KINDS) {
    const m = kind.test.exec(text);
    if (!m) continue;
    const number = Number(m[1]);
    const replay = /replay/i.test(text.slice(m[0].length));
    return {
      id: `${kind.key}${number}${replay ? "r" : ""}`,
      short: `${kind.short}${number}${replay ? " replay" : ""}`,
      long: `${kind.long} ${number}${replay ? " replay" : ""}`,
      order: kind.order * 10000 + number * 2 + (replay ? 1 : 0),
    };
  }
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { id: slug ? `x-${slug}` : "", short: text, long: text, order: 90000 };
}

export const shortLabel = (match) => readLabel(match.label).short;
export const longLabel = (match) => readLabel(match.label).long;

/** Epoch milliseconds from whatever a feed sent: milliseconds, seconds, or an ISO string. */
export function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return toMs(asNumber);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const first = (...values) => values.find((v) => v !== null && v !== undefined) ?? null;
const teamList = (value) => (Array.isArray(value) ? value : []).filter((t) => t !== null && t !== undefined && t !== "").map((t) => String(t).trim());

/**
 * Read a Nexus event response.
 *
 * The field names here are the ones in Nexus's public API reference as of 2026 (`matches[].label`,
 * `status`, `redTeams`, `blueTeams`, `times.estimatedQueueTime` and its siblings, `nowQueuing`,
 * `dataAsOfTime`, `announcements[].announcement`). They have not been checked against a live key
 * from this app, so every one is read defensively: a missing or oddly typed field leaves a blank,
 * never a guess, and a response with no match list at all is reported as unreadable.
 *
 * Returns `{ error }`, or the event with only this team's matches kept.
 */
export function parseNexus(json, team) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return { error: "Nexus sent something that is not an event." };
  if (!Array.isArray(json.matches)) return { error: "Nexus sent an event with no match list." };

  const us = String(team);
  const matches = [];
  for (const raw of json.matches) {
    if (raw === null || typeof raw !== "object") continue;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const read = readLabel(label);
    if (!read.id) continue;

    const red = teamList(first(raw.redTeams, raw.red));
    const blue = teamList(first(raw.blueTeams, raw.blue));
    const alliance = red.includes(us) ? "red" : blue.includes(us) ? "blue" : null;
    if (!alliance) continue;

    const t = raw.times !== null && typeof raw.times === "object" ? raw.times : {};
    const queueActual = toMs(t.actualQueueTime);
    const onFieldActual = toMs(t.actualOnFieldTime);
    matches.push({
      id: read.id,
      label,
      source: "nexus",
      status: typeof raw.status === "string" ? raw.status.trim() : "",
      alliance,
      red,
      blue,
      times: {
        queue: first(queueActual, toMs(t.estimatedQueueTime)),
        onDeck: first(toMs(t.actualOnDeckTime), toMs(t.estimatedOnDeckTime)),
        onField: first(onFieldActual, toMs(t.estimatedOnFieldTime)),
        start: first(toMs(t.actualStartTime), toMs(t.estimatedStartTime), toMs(t.scheduledStartTime)),
        queueActual: queueActual !== null,
        onFieldActual: onFieldActual !== null,
      },
    });
  }

  const announcements = (Array.isArray(json.announcements) ? json.announcements : [])
    .filter((a) => a !== null && typeof a === "object")
    .map((a) => ({ text: typeof a.announcement === "string" ? a.announcement.trim() : "", at: toMs(a.postedTime) }))
    .filter((a) => a.text);

  return {
    eventKey: typeof json.eventKey === "string" ? json.eventKey : "",
    asOf: toMs(json.dataAsOfTime),
    nowQueuing: typeof json.nowQueuing === "string" ? json.nowQueuing.trim() : "",
    matches,
    eventMatchCount: json.matches.length,
    announcements,
  };
}

/**
 * Fold a Nexus response into the schedule. A match already there — typed in, or from an earlier
 * fetch — is updated in place and keeps its played mark, its log, its ticks and its history, since
 * all of those hang off the id. Matches Nexus no longer lists are left alone.
 */
export function mergeNexus(state, parsed, now) {
  let added = 0;
  let updated = 0;
  for (const incoming of parsed.matches) {
    const existing = state.schedule.find((m) => m.id === incoming.id);
    if (existing) {
      Object.assign(existing, incoming, { played: existing.played, playedAt: existing.playedAt });
      updated++;
    } else {
      state.schedule.push({ ...incoming, played: false, playedAt: null });
      added++;
    }
  }
  state.nexus = {
    eventKey: parsed.eventKey,
    fetchedAt: now,
    asOf: parsed.asOf,
    nowQueuing: parsed.nowQueuing,
    announcements: parsed.announcements,
  };
  return { added, updated };
}

/**
 * Add a match by hand. `start` and `queue` are epoch milliseconds or null; partners and opponents
 * are whatever team numbers are known, which may be none.
 */
export function addMatch(state, { label, start = null, queue = null, alliance = null, partners = [], opponents = [] }, team) {
  const read = readLabel(label);
  if (!read.id) return { error: "Give the match a label, such as Q12." };
  if (state.schedule.some((m) => m.id === read.id)) return { error: `${read.short} is already on the schedule.` };

  const side = alliance === "red" || alliance === "blue" ? alliance : null;
  const ours = side ? [String(team), ...teamList(partners)] : [];
  const theirs = side ? teamList(opponents) : [];
  const match = {
    id: read.id,
    label: read.long,
    source: "manual",
    status: "",
    alliance: side,
    red: side === "red" ? ours : side === "blue" ? theirs : [],
    blue: side === "blue" ? ours : side === "red" ? theirs : [],
    times: {
      queue: Number.isFinite(queue) ? queue : null,
      onDeck: null,
      onField: null,
      start: Number.isFinite(start) ? start : null,
      queueActual: false,
      onFieldActual: false,
    },
    played: false,
    playedAt: null,
  };
  state.schedule.push(match);
  return { match };
}

/** Change a hand-entered match's times or alliance. The label, and so the id, stays. */
export function editMatch(state, id, { start, queue, alliance, partners, opponents }, team) {
  const match = state.schedule.find((m) => m.id === id);
  if (!match) return { error: "No such match." };
  if (start !== undefined) match.times.start = Number.isFinite(start) ? start : null;
  if (queue !== undefined) match.times.queue = Number.isFinite(queue) ? queue : null;
  if (alliance !== undefined) {
    const side = alliance === "red" || alliance === "blue" ? alliance : null;
    const ours = side ? [String(team), ...teamList(partners)] : [];
    const theirs = side ? teamList(opponents) : [];
    match.alliance = side;
    match.red = side === "red" ? ours : side === "blue" ? theirs : [];
    match.blue = side === "blue" ? ours : side === "red" ? theirs : [];
  }
  return { match };
}

/** Take a match off the schedule, with its unticked draft. Its log and its stamped runs stay. */
export function removeMatch(state, id) {
  const before = state.schedule.length;
  state.schedule = state.schedule.filter((m) => m.id !== id);
  delete state.checklist.drafts[id];
  return state.schedule.length < before;
}

export function markPlayed(state, id, played, now) {
  const match = state.schedule.find((m) => m.id === id);
  if (!match) return false;
  match.played = played;
  match.playedAt = played ? now : null;
  return true;
}

/**
 * Whether a match is behind us. Someone saying so always counts. Otherwise only Nexus can say: a
 * match it reports as having actually taken the field more than twelve minutes ago has been played.
 * A hand-entered start time passing proves nothing, because events run late.
 */
export function isPlayed(match, now) {
  if (match.played) return true;
  if (match.source !== "nexus") return false;
  return match.times.onFieldActual && match.times.onField !== null && now - match.times.onField > PLAYED_AFTER_ON_FIELD;
}

const timeKey = (match) => first(match.times.start, match.times.onField, match.times.queue);

/** The schedule in playing order: by time where there is one, by match number where there is not. */
export function sorted(state) {
  return [...state.schedule].sort((a, b) => {
    const ta = timeKey(a);
    const tb = timeKey(b);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    return readLabel(a.label).order - readLabel(b.label).order;
  });
}

/** The first match that has not been played, or null. */
export function nextMatch(state, now) {
  return sorted(state).find((m) => !isPlayed(m, now)) || null;
}

export function byId(state, id) {
  return state.schedule.find((m) => m.id === id) || null;
}

/** The team's side of a match: alliance, partners and opponents, each as far as it is known. */
export function sides(match, team) {
  const us = String(team);
  if (!match.alliance) return { alliance: null, partners: [], opponents: [] };
  const ours = match.alliance === "red" ? match.red : match.blue;
  const theirs = match.alliance === "red" ? match.blue : match.red;
  return { alliance: match.alliance, partners: ours.filter((t) => t !== us), opponents: theirs };
}

const LIVE = /queu|deck|field/i;

/**
 * What to show as "how long". One of:
 *   status  Nexus says the match is being queued, is on deck or is on the field; show its words
 *   queue   counting down to a known queue time
 *   start   no queue time known; counting down to the start
 *   none    no time known at all
 * `late` is set when the time has already passed, with `ms` how long ago. `estimate` is set when
 * the time is Nexus's running estimate; a typed-in time is the printed schedule and is not.
 */
export function timing(match, now) {
  const fromNexus = match.source === "nexus";
  if (fromNexus && match.status && LIVE.test(match.status) && !/soon/i.test(match.status)) {
    return { kind: "status", text: match.status, at: null, ms: 0, late: false, estimate: false };
  }
  const { queue, start, queueActual } = match.times;
  if (queue !== null && !queueActual) {
    return { kind: "queue", text: "", at: queue, ms: Math.abs(queue - now), late: queue < now, estimate: fromNexus };
  }
  if (queue !== null && queueActual) {
    return { kind: "status", text: match.status || "Queued", at: queue, ms: 0, late: false, estimate: false };
  }
  if (start !== null) {
    return { kind: "start", text: "", at: start, ms: Math.abs(start - now), late: start < now, estimate: fromNexus };
  }
  return { kind: "none", text: "", at: null, ms: 0, late: false, estimate: false };
}

/** How old the Nexus data is, and whether that is old enough to say so. Null when there is none. */
export function freshness(nexus, now) {
  if (!nexus || nexus.fetchedAt === null) return null;
  const age = Math.max(0, now - nexus.fetchedAt);
  return { age, stale: age > STALE_AFTER, at: nexus.fetchedAt };
}
