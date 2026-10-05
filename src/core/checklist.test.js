import test from "node:test";
import assert from "node:assert/strict";

import { defaults } from "./store.js";
import {
  NO_MATCH, defaultGroups, toggle, isTicked, progress, stampRun, lastRunFor, runSummary, clearTicks,
  addItem, renameItem, removeItem, moveItem, addGroup, renameGroup, removeGroup, resetList,
} from "./checklist.js";

const allItems = (state) => state.checklist.groups.flatMap((g) => g.items);

test("the starting list has the four groups and no duplicate ids", () => {
  const groups = defaultGroups();
  assert.deepEqual(groups.map((g) => g.name), ["Mechanical", "Electrical", "Software", "Drive team"]);
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 20);
});

test("ticks belong to a match: a new match starts with none", () => {
  const state = defaults();
  const [a, b] = allItems(state);
  assert.equal(toggle(state.checklist, "q12", a.id, 100), true);
  assert.equal(toggle(state.checklist, "q12", b.id, 110), true);
  assert.equal(progress(state.checklist, "q12").done, 2);
  assert.equal(progress(state.checklist, "q13").done, 0, "Q13 does not inherit Q12's ticks");
  assert.equal(isTicked(state.checklist, "q13", a.id), false);
  assert.equal(progress(state.checklist, "q12").started, true);
});

test("ticking twice unticks, and an empty draft is not kept", () => {
  const state = defaults();
  const [a] = allItems(state);
  toggle(state.checklist, "q1", a.id, 1);
  assert.equal(toggle(state.checklist, "q1", a.id, 2), false);
  assert.deepEqual(state.checklist.drafts, {});
});

test("with no match chosen, ticks are kept under their own key", () => {
  const state = defaults();
  const [a] = allItems(state);
  toggle(state.checklist, null, a.id, 1);
  assert.ok(state.checklist.drafts[NO_MATCH]);
  assert.equal(isTicked(state.checklist, null, a.id), true);
  assert.equal(isTicked(state.checklist, "q1", a.id), false);
});

test("stamping a full run records it with the time and the match, and resets the ticks", () => {
  const state = defaults();
  for (const item of allItems(state)) toggle(state.checklist, "q12", item.id, 500);
  assert.equal(progress(state.checklist, "q12").complete, true);

  const run = stampRun(state, "q12", "Qualification 12", 900);
  assert.equal(run.at, 900);
  assert.equal(run.matchId, "q12");
  assert.equal(run.matchLabel, "Qualification 12");
  assert.equal(run.done, run.total);
  assert.deepEqual(run.missed, []);
  assert.equal(runSummary(run), `${run.total} of ${run.total}`);

  assert.equal(progress(state.checklist, "q12").done, 0, "the ticks reset");
  assert.deepEqual(state.checklist.history, [run]);
  assert.equal(lastRunFor(state.checklist, "q12"), run);
  assert.equal(lastRunFor(state.checklist, "q13"), null);
});

test("a run stamped with gaps says exactly what was skipped", () => {
  const state = defaults();
  const items = allItems(state);
  for (const item of items.slice(2)) toggle(state.checklist, "q3", item.id, 1);
  const run = stampRun(state, "q3", "Qualification 3", 2);
  assert.equal(run.done, items.length - 2);
  assert.deepEqual(run.missed, [
    { group: "Mechanical", text: items[0].text },
    { group: "Mechanical", text: items[1].text },
  ]);
  assert.equal(runSummary(run), `${items.length - 2} of ${items.length}, 2 skipped`);
});

test("history keeps every run, in order, including a second run for the same match", () => {
  const state = defaults();
  const [a] = allItems(state);
  toggle(state.checklist, "q1", a.id, 1);
  const first = stampRun(state, "q1", "Qualification 1", 10);
  toggle(state.checklist, "q1", a.id, 11);
  const second = stampRun(state, "q1", "Qualification 1", 20);
  toggle(state.checklist, "q2", a.id, 21);
  stampRun(state, "q2", "Qualification 2", 30);
  assert.deepEqual(state.checklist.history.map((h) => h.at), [10, 20, 30]);
  assert.notEqual(first.id, second.id);
  assert.equal(lastRunFor(state.checklist, "q1"), second);
});

test("stamping one match leaves another match's ticks alone", () => {
  const state = defaults();
  const [a, b] = allItems(state);
  toggle(state.checklist, "q1", a.id, 1);
  toggle(state.checklist, "q2", b.id, 2);
  stampRun(state, "q1", "Qualification 1", 3);
  assert.equal(isTicked(state.checklist, "q2", b.id), true);
});

test("an empty list cannot be stamped", () => {
  const state = defaults();
  state.checklist.groups = [];
  assert.equal(stampRun(state, "q1", "Qualification 1", 1), null);
  assert.deepEqual(state.checklist.history, []);
});

test("clearing ticks records nothing", () => {
  const state = defaults();
  toggle(state.checklist, "q1", allItems(state)[0].id, 1);
  clearTicks(state.checklist, "q1");
  assert.equal(progress(state.checklist, "q1").done, 0);
  assert.deepEqual(state.checklist.history, []);
});

test("items can be added, renamed, moved and removed", () => {
  const state = defaults();
  const added = addItem(state, "electrical", "  Pneumatics   charged ");
  assert.equal(added.text, "Pneumatics charged");
  assert.equal(addItem(state, "electrical", "   "), null);
  assert.equal(addItem(state, "nowhere", "x"), null);

  assert.equal(renameItem(state, added.id, "Compressor off"), true);
  assert.equal(renameItem(state, added.id, ""), false, "a blank name is refused and the old one kept");
  const electrical = state.checklist.groups.find((g) => g.id === "electrical");
  assert.equal(electrical.items.at(-1).text, "Compressor off");

  assert.equal(moveItem(state, added.id, -1), true);
  assert.equal(electrical.items.at(-2).id, added.id);
  assert.equal(moveItem(state, electrical.items[0].id, -1), false, "the first item cannot go further up");

  toggle(state.checklist, "q1", added.id, 1);
  assert.equal(removeItem(state, added.id), true);
  assert.equal(electrical.items.some((i) => i.id === added.id), false);
  assert.deepEqual(state.checklist.drafts, {}, "its tick went with it");
});

test("a deleted item no longer counts toward progress", () => {
  const state = defaults();
  const total = allItems(state).length;
  const [a] = allItems(state);
  toggle(state.checklist, "q1", a.id, 1);
  removeItem(state, a.id);
  const p = progress(state.checklist, "q1");
  assert.equal(p.total, total - 1);
  assert.equal(p.done, 0);
});

test("groups can be added, renamed and removed with their items", () => {
  const state = defaults();
  const group = addGroup(state, "Pneumatics");
  const item = addItem(state, group.id, "Tank at pressure");
  assert.equal(renameGroup(state, group.id, "Air"), true);
  assert.equal(state.checklist.groups.at(-1).name, "Air");
  toggle(state.checklist, "q1", item.id, 1);
  assert.equal(removeGroup(state, group.id), true);
  assert.equal(state.checklist.groups.some((g) => g.id === group.id), false);
  assert.deepEqual(state.checklist.drafts, {});
});

test("resetting the list brings the starting one back and drops stale ticks", () => {
  const state = defaults();
  removeGroup(state, "software");
  toggle(state.checklist, "q1", "mechanical-1", 1);
  resetList(state);
  assert.deepEqual(state.checklist.groups, defaultGroups());
  assert.deepEqual(state.checklist.drafts, {});
});
