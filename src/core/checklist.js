// The pre-match checklist: what is on it, what has been ticked for which match, and the record of
// each run.
//
// Ticks belong to a match. Every match starts with nothing ticked, and a tick made for Q12 is not
// there when the screen is turned to Q13 — which is the whole point of a checklist, since the one
// habit it exists to break is "we checked that earlier". Stamping a run writes it to history with
// the time, the match and what was left unticked, and clears that match's ticks.
//
// A run can be stamped with items unticked. A robot sometimes goes out with a known gap, and a
// checklist that refuses to record that gets abandoned; the record says exactly what was skipped.

import { nextId } from "./store.js";

/** The key ticks are kept under when no match is chosen: a practice run, or no schedule yet. */
export const NO_MATCH = "_";

/**
 * The list a new event starts with: a swerve robot with an intake and a shooter, kept general
 * enough to be right for most of them. It is a starting point; every line can be edited.
 */
export function defaultGroups() {
  const group = (id, name, items) => ({ id, name, items: items.map((text, i) => ({ id: `${id}-${i + 1}`, text })) });
  return [
    group("mechanical", "Mechanical", [
      "Bumpers on, right colour, pins in",
      "Swerve modules: wheels tight, tread not worn through",
      "Intake moves freely by hand, nothing bent",
      "Shooter wheels spin freely, no cracks or chunks",
      "Hopper and indexer clear of debris",
      "Belts and chains tensioned, none frayed",
      "No loose bolts on the frame or mechanisms",
    ]),
    group("electrical", "Electrical", [
      "Fresh battery in and strapped down",
      "Battery connector fully seated, leads tight on the terminals",
      "Main breaker on, lugs tight",
      "Radio powered, both ends of its cables latched",
      "CAN and power connectors pass a tug test",
      "No wire within reach of a moving part",
    ]),
    group("software", "Software", [
      "Latest code deployed, not a test build",
      "Driver Station shows communications and robot code",
      "Controllers in the right slots",
      "Autonomous routine chosen and read back",
      "No fault on the dashboard that was not there last match",
      "Cameras streaming",
    ]),
    group("drive-team", "Drive team", [
      "Alliance colour and station known",
      "Strategy agreed with alliance partners",
      "Game pieces preloaded",
      "Driver Station laptop charged, on the cart",
      "Safety glasses for everyone going to the field",
    ]),
  ];
}

const draftFor = (checklist, matchId) => checklist.drafts[matchId || NO_MATCH];

/** Whether an item is ticked for a match. */
export function isTicked(checklist, matchId, itemId) {
  return Boolean(draftFor(checklist, matchId)?.ticks[itemId]);
}

/** Tick or untick one item for one match. Returns the new state of the tick. */
export function toggle(checklist, matchId, itemId, now) {
  const key = matchId || NO_MATCH;
  const draft = (checklist.drafts[key] ??= { ticks: {} });
  if (draft.ticks[itemId]) {
    delete draft.ticks[itemId];
    if (!Object.keys(draft.ticks).length) delete checklist.drafts[key];
    return false;
  }
  draft.ticks[itemId] = now;
  return true;
}

/**
 * How far through the list a match is. Counted against the list as it stands now, so an item that
 * was deleted after it was ticked neither counts nor blocks.
 */
export function progress(checklist, matchId) {
  const ticks = draftFor(checklist, matchId)?.ticks ?? {};
  let done = 0;
  let total = 0;
  const groups = checklist.groups.map((g) => {
    const d = g.items.filter((i) => ticks[i.id]).length;
    done += d;
    total += g.items.length;
    return { id: g.id, name: g.name, done: d, total: g.items.length };
  });
  return { done, total, groups, complete: total > 0 && done === total, started: done > 0 };
}

/** Clear a match's ticks without recording anything. */
export function clearTicks(checklist, matchId) {
  delete checklist.drafts[matchId || NO_MATCH];
}

/**
 * Record a run and clear its ticks. Returns the history entry, or null when the list is empty —
 * a run of nothing is not a run.
 */
export function stampRun(state, matchId, matchLabel, now) {
  const { checklist } = state;
  const p = progress(checklist, matchId);
  if (!p.total) return null;
  const ticks = draftFor(checklist, matchId)?.ticks ?? {};
  const missed = [];
  for (const g of checklist.groups) {
    for (const item of g.items) if (!ticks[item.id]) missed.push({ group: g.name, text: item.text });
  }
  const entry = {
    id: nextId(state, "r"),
    at: now,
    matchId: matchId || null,
    matchLabel: matchLabel || "",
    total: p.total,
    done: p.done,
    missed,
  };
  checklist.history.push(entry);
  clearTicks(checklist, matchId);
  return entry;
}

/** The most recent stamped run for a match, or null. */
export function lastRunFor(checklist, matchId) {
  for (let i = checklist.history.length - 1; i >= 0; i--) {
    if (checklist.history[i].matchId === (matchId || null)) return checklist.history[i];
  }
  return null;
}

/** A run in a few words: "26 of 26" or "23 of 26, 3 skipped". */
export function runSummary(run) {
  const skipped = run.total - run.done;
  return skipped ? `${run.done} of ${run.total}, ${skipped} skipped` : `${run.done} of ${run.total}`;
}

// ---- editing the list --------------------------------------------------------------------------

const findGroup = (checklist, groupId) => checklist.groups.find((g) => g.id === groupId);

function locate(checklist, itemId) {
  for (const group of checklist.groups) {
    const index = group.items.findIndex((i) => i.id === itemId);
    if (index >= 0) return { group, index };
  }
  return null;
}

const clean = (text) => (typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "");

export function addItem(state, groupId, text) {
  const group = findGroup(state.checklist, groupId);
  const value = clean(text);
  if (!group || !value) return null;
  const item = { id: nextId(state, "c"), text: value };
  group.items.push(item);
  return item;
}

export function renameItem(state, itemId, text) {
  const at = locate(state.checklist, itemId);
  const value = clean(text);
  if (!at || !value) return false;
  at.group.items[at.index].text = value;
  return true;
}

/** Remove an item, and its tick from every match that had one. */
export function removeItem(state, itemId) {
  const at = locate(state.checklist, itemId);
  if (!at) return false;
  at.group.items.splice(at.index, 1);
  for (const [key, draft] of Object.entries(state.checklist.drafts)) {
    delete draft.ticks[itemId];
    if (!Object.keys(draft.ticks).length) delete state.checklist.drafts[key];
  }
  return true;
}

/** Move an item one place up (-1) or down (+1) within its group. */
export function moveItem(state, itemId, direction) {
  const at = locate(state.checklist, itemId);
  if (!at) return false;
  const to = at.index + direction;
  if (to < 0 || to >= at.group.items.length) return false;
  const [item] = at.group.items.splice(at.index, 1);
  at.group.items.splice(to, 0, item);
  return true;
}

export function addGroup(state, name) {
  const value = clean(name);
  if (!value) return null;
  const group = { id: nextId(state, "g"), name: value, items: [] };
  state.checklist.groups.push(group);
  return group;
}

export function renameGroup(state, groupId, name) {
  const group = findGroup(state.checklist, groupId);
  const value = clean(name);
  if (!group || !value) return false;
  group.name = value;
  return true;
}

export function removeGroup(state, groupId) {
  const group = findGroup(state.checklist, groupId);
  if (!group) return false;
  for (const item of [...group.items]) removeItem(state, item.id);
  state.checklist.groups = state.checklist.groups.filter((g) => g.id !== groupId);
  return true;
}

/** Put the starting list back. Ticks go with it, since they point at items that no longer exist. */
export function resetList(state) {
  state.checklist.groups = defaultGroups();
  state.checklist.drafts = {};
}
