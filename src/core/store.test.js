import test from "node:test";
import assert from "node:assert/strict";

import { SCHEMA, defaults, migrate, nextEvent, nextId } from "./store.js";
import { addBattery, putOnCharge, markReady, putInRobot } from "./batteries.js";
import { addIssue, fixIssue } from "./matchlog.js";
import { addMatch } from "./queue.js";
import { toggle, stampRun, addItem } from "./checklist.js";

test("nothing on disk is a new, empty event", () => {
  const { status, state } = migrate(null);
  assert.equal(status, "new");
  assert.equal(state.schema, SCHEMA);
  assert.deepEqual(state.batteries, []);
  assert.deepEqual(state.schedule, []);
  assert.deepEqual(state.issues, []);
  assert.deepEqual(state.checklist.history, []);
  assert.ok(state.checklist.groups.length >= 4, "the starting checklist is there");
});

test("a current file round-trips through JSON unchanged", () => {
  const state = defaults();
  addBattery(state, "B1", 1000);
  putOnCharge(state, "b1", 2000);
  markReady(state, "b1", { volts: 12.9, mohm: 12 }, 3000);
  addMatch(state, { label: "Q12", start: 9000, alliance: "red", partners: ["254"] }, 5805);
  toggle(state.checklist, "q12", "mechanical-1", 4000);
  addIssue(state, { title: "Intake plate cracked", severity: "high", matchId: "q12" }, 5000);

  const { status, state: back } = migrate(JSON.parse(JSON.stringify(state)));
  assert.equal(status, "ok");
  assert.deepEqual(back, state);
});

test("a file with no schema field is stepped forward and keeps what it has", () => {
  const old = {
    batteries: [{ id: "b1", label: "Old Faithful", state: "ready", cycles: 14, readings: [{ at: 5, kind: "rest", volts: 12.8 }] }],
    issues: [{ id: "i2", title: "Loose bumper pin" }],
  };
  const { status, state, from } = migrate(old);
  assert.equal(status, "migrated");
  assert.equal(from, 0);
  assert.equal(state.schema, SCHEMA);
  assert.equal(state.batteries[0].label, "Old Faithful");
  assert.equal(state.batteries[0].cycles, 14);
  assert.equal(state.batteries[0].readings[0].volts, 12.8);
  assert.equal(state.batteries[0].readings[0].mohm, null, "a field the old file lacked is blank, not zero");
  assert.equal(state.issues[0].state, "open");
  assert.equal(state.issues[0].severity, "medium");
  assert.ok(state.checklist.groups.length, "the checklist it never had is the starting one");
});

test("a file from a newer build is refused, not rewritten", () => {
  const { status, state, from } = migrate({ schema: SCHEMA + 1, batteries: [{ id: "b1", label: "B1" }] });
  assert.equal(status, "newer");
  assert.equal(state, null);
  assert.equal(from, SCHEMA + 1);
});

test("something that is not an object is refused", () => {
  assert.equal(migrate([]).status, "invalid");
  assert.equal(migrate("pit").status, "invalid");
  assert.equal(migrate(7).status, "invalid");
  assert.equal(migrate({ schema: -3 }).status, "invalid");
});

test("damaged entries are dropped and sound ones kept", () => {
  const { state } = migrate({
    schema: SCHEMA,
    batteries: [null, { id: "b1" }, { id: "b2", label: "B2", state: "exploded", cycles: -4, readings: [{ kind: "in" }, { at: 9, kind: "odd", volts: "12" }] }],
    schedule: [{ id: "q1", label: "Qualification 1", alliance: "green", times: { start: "soon" } }, { label: "no id" }],
    log: { q1: { batteryId: 5, notes: "ran well" }, q2: "nope" },
    checklist: { groups: [{ id: "g", name: "Only", items: [{ id: "a", text: "One" }, { id: "b" }] }], drafts: { q1: { ticks: { a: 10, b: "yes" } } }, history: [{ id: "r1" }] },
  });
  assert.equal(state.batteries.length, 1);
  assert.equal(state.batteries[0].state, "resting", "an unknown state falls back to the one that claims nothing");
  assert.equal(state.batteries[0].cycles, 0);
  assert.equal(state.batteries[0].readings.length, 1);
  assert.equal(state.batteries[0].readings[0].volts, null, "a voltage that is not a number is blank");
  assert.equal(state.schedule.length, 1);
  assert.equal(state.schedule[0].alliance, null);
  assert.equal(state.schedule[0].times.start, null);
  assert.deepEqual(state.log, { q1: { batteryId: null, notes: "ran well" } });
  assert.equal(state.checklist.groups[0].items.length, 1);
  assert.deepEqual(state.checklist.drafts, { q1: { ticks: { a: 10 } } });
  assert.deepEqual(state.checklist.history, []);
});

test("the id counter never falls behind the ids already in the file", () => {
  const { state } = migrate({ schema: SCHEMA, seq: 1, batteries: [{ id: "b7", label: "B7" }], issues: [{ id: "i12", title: "x" }] });
  assert.equal(state.seq, 12);
  assert.equal(nextId(state, "b"), "b13");
});

test("the next event keeps the team's things and leaves the event's behind", () => {
  const state = defaults();
  state.event.name = "First event";
  addBattery(state, "B1", 1);
  putOnCharge(state, "b1", 2);
  addMatch(state, { label: "Q1", start: 100 }, 5805);
  putInRobot(state, "b1", { volts: 12.9, matchId: "q1" }, 3);
  addItem(state, "mechanical", "Check the new climber hook");
  toggle(state.checklist, "q1", "mechanical-1", 4);
  stampRun(state, "q1", "Qualification 1", 5);
  addIssue(state, { title: "Still broken", matchId: "q1" }, 6);
  const done = addIssue(state, { title: "Was fixed", matchId: "q1" }, 7).issue;
  fixIssue(state, done.id, "replaced", 8);
  state.log.q1.notes = "good match";

  const next = nextEvent(state, "  Second event ", 1000);
  assert.equal(next.event.name, "Second event");
  assert.equal(next.event.startedAt, 1000);
  assert.deepEqual(next.schedule, []);
  assert.deepEqual(next.log, {});
  assert.deepEqual(next.checklist.history, []);
  assert.deepEqual(next.checklist.drafts, {});
  assert.equal(next.batteries.length, 1);
  assert.equal(next.batteries[0].cycles, 1, "wear carries over");
  assert.equal(next.batteries[0].readings[0].matchId, null, "but not the old event's match");
  assert.ok(next.checklist.groups[0].items.some((i) => i.text === "Check the new climber hook"));
  assert.deepEqual(next.issues.map((i) => i.title), ["Still broken"]);
  assert.equal(next.issues[0].matchId, null);
  assert.ok(next.seq >= state.seq, "ids carry on from where they were");
  assert.equal(state.event.name, "First event", "the old event is not touched");
});
