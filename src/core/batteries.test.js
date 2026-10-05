import test from "node:test";
import assert from "node:assert/strict";

import { defaults } from "./store.js";
import {
  DEFAULT_LIMITS, addBattery, renameBattery, removeBattery, putInRobot, takeOut, putOnCharge, markReady,
  logRest, retire, unretire, inRobot, restedVolts, lastMilliohm, chargeTime, flags, recommend, boardOrder,
} from "./batteries.js";

const MIN = 60000;

/** A board with labelled batteries, all just added. Returns the state and the batteries by label. */
function board(...labels) {
  const state = defaults();
  const by = {};
  for (const label of labels) by[label] = addBattery(state, label, 0).battery;
  return { state, by };
}

/** Put a battery on charge at `since`, and mark it ready at `readyAt` with a resting voltage. */
function charged(state, battery, since, readyAt, volts, mohm = null) {
  putOnCharge(state, battery.id, since);
  if (readyAt !== null) markReady(state, battery.id, { volts, mohm }, readyAt);
}

test("a battery is added by its label, once", () => {
  const state = defaults();
  const { battery } = addBattery(state, "  B 1 ", 5);
  assert.equal(battery.label, "B 1");
  assert.equal(battery.state, "resting", "new to the board is not claimed to be charged");
  assert.equal(battery.cycles, 0);
  assert.ok(addBattery(state, "b 1", 6).error, "the same label in another case is the same battery");
  assert.ok(addBattery(state, "   ", 6).error);
  assert.equal(state.batteries.length, 1);
});

test("the loop: charge, ready, in, out, and one cycle counted", () => {
  const { state, by } = board("B1");
  const b = by.B1;
  putOnCharge(state, b.id, 10 * MIN);
  assert.equal(b.state, "charging");
  assert.equal(b.chargeSince, 10 * MIN);

  markReady(state, b.id, { volts: 12.95 }, 70 * MIN);
  assert.equal(b.state, "ready");
  assert.equal(restedVolts(b), 12.95);
  assert.equal(chargeTime(b, 100 * MIN), 90 * MIN, "time on charge runs from when it went on, through ready");

  assert.ok(!putInRobot(state, b.id, { volts: 12.9, mohm: 13, matchId: "q4" }, 100 * MIN).error);
  assert.equal(b.state, "in-robot");
  assert.equal(b.cycles, 1);
  assert.equal(inRobot(state), b);
  assert.equal(state.log.q4.batteryId, b.id, "the match's log records which battery it used");
  assert.equal(chargeTime(b, 101 * MIN), null);

  assert.ok(!takeOut(state, b.id, { volts: 12.1 }, 115 * MIN).error);
  assert.equal(b.state, "resting");
  assert.equal(inRobot(state), null);
  const out = b.readings.at(-1);
  assert.deepEqual([out.kind, out.volts, out.matchId], ["out", 12.1, "q4"], "the out-reading belongs to the same match");
  assert.equal(b.cycles, 1);
  assert.equal(restedVolts(b), null, "a resting voltage from before the match no longer describes it");
  assert.equal(lastMilliohm(b), 13);
});

test("only one battery is ever in the robot", () => {
  const { state, by } = board("B1", "B2");
  putInRobot(state, by.B1.id, { volts: 12.8 }, 1);
  const second = putInRobot(state, by.B2.id, { volts: 12.9 }, 2);
  assert.match(second.error, /B1 is still marked in the robot/);
  assert.equal(by.B2.state, "resting");
  assert.equal(by.B2.cycles, 0);
  assert.ok(putInRobot(state, by.B1.id, {}, 3).error, "and the one that is in cannot go in again");
  assert.equal(by.B1.cycles, 1);
});

test("a battery can go in unmeasured: the cycle counts and no reading is invented", () => {
  const { state, by } = board("B1");
  putInRobot(state, by.B1.id, {}, 1);
  assert.equal(by.B1.cycles, 1);
  assert.deepEqual(by.B1.readings, []);
  takeOut(state, by.B1.id, { volts: null }, 2);
  assert.deepEqual(by.B1.readings, []);
});

test("moves that make no sense are refused with a reason", () => {
  const { state, by } = board("B1");
  assert.match(takeOut(state, by.B1.id, {}, 1).error, /not in the robot/);
  putInRobot(state, by.B1.id, {}, 2);
  assert.match(putOnCharge(state, by.B1.id, 3).error, /Take it out first/);
  assert.match(retire(state, by.B1.id, 3).error, /Take it out first/);
  assert.ok(markReady(state, by.B1.id, {}, 3).error);
  takeOut(state, by.B1.id, {}, 4);
  retire(state, by.B1.id, 5);
  assert.match(putInRobot(state, by.B1.id, {}, 6).error, /retired/);
  assert.ok(!unretire(state, by.B1.id, 7).error);
  assert.equal(by.B1.state, "resting");
  assert.ok(logRest(state, by.B1.id, {}, 8).error, "a reading with nothing in it is not a reading");
});

test("ready back to charging is the same charge, not a new one", () => {
  const { state, by } = board("B1");
  charged(state, by.B1, 10 * MIN, 60 * MIN, 12.9);
  putOnCharge(state, by.B1.id, 80 * MIN);
  assert.equal(by.B1.chargeSince, 10 * MIN);
});

test("recommends the highest rested voltage among the ready", () => {
  const { state, by } = board("B1", "B2", "B3");
  charged(state, by.B1, 0, 60 * MIN, 12.71);
  charged(state, by.B2, 0, 60 * MIN, 13.02);
  charged(state, by.B3, 0, 60 * MIN, 12.88);
  const rec = recommend(state, 90 * MIN);
  assert.equal(rec.pick.battery.label, "B2");
  assert.deepEqual(rec.ranked.map((c) => c.battery.label), ["B2", "B3", "B1"]);
  assert.match(rec.reason, /ready · 13\.02 V rested · 1 h 30 min on charge/);
  assert.equal(rec.caution, null);
});

test("equal voltages are settled by the longest on charge", () => {
  const { state, by } = board("B1", "B2");
  charged(state, by.B1, 40 * MIN, 80 * MIN, 12.91);
  charged(state, by.B2, 5 * MIN, 80 * MIN, 12.93);   // within 0.05 V of B1: the same reading
  const rec = recommend(state, 100 * MIN);
  assert.equal(rec.pick.battery.label, "B2", "B2 has been on charge 35 minutes longer");
  assert.match(rec.reason, /1 h 35 min on charge/);
});

test("a ready battery beats a charging one whatever the charger shows", () => {
  const { state, by } = board("B1", "B2");
  charged(state, by.B1, 0, 60 * MIN, 12.7);
  putOnCharge(state, by.B2.id, 0);
  logRest(state, by.B2.id, { volts: 13.6 }, 50 * MIN);   // read on the charger: surface charge
  assert.equal(recommend(state, 90 * MIN).pick.battery.label, "B1");
});

test("a measured battery beats an unmeasured one", () => {
  const { state, by } = board("B1", "B2");
  putOnCharge(state, by.B1.id, 0);
  markReady(state, by.B1.id, {}, 60 * MIN);              // called ready, never measured
  charged(state, by.B2, 30 * MIN, 60 * MIN, 12.6);
  const rec = recommend(state, 90 * MIN);
  assert.equal(rec.pick.battery.label, "B2");
  assert.equal(rec.ranked[1].rest, null);
});

test("a weak battery is flagged and ranked last, even with the best voltage", () => {
  const { state, by } = board("B1", "B2");
  charged(state, by.B1, 0, 60 * MIN, 13.1, 24);
  charged(state, by.B2, 0, 60 * MIN, 12.7, 13);
  const rec = recommend(state, 90 * MIN);
  assert.equal(rec.pick.battery.label, "B2");
  assert.deepEqual(flags(by.B1).map((f) => [f.id, f.level]), [["resistance", "weak"]]);
  assert.deepEqual(flags(by.B2), []);
  assert.equal(rec.ranked[1].weak, true);
});

test("when every candidate is weak the least bad is offered, with a caution", () => {
  const { state, by } = board("B1", "B2");
  charged(state, by.B1, 0, 60 * MIN, 12.2);    // ready but rests low
  charged(state, by.B2, 0, 60 * MIN, 12.9, 26);
  const rec = recommend(state, 90 * MIN);
  assert.ok(rec.pick);
  assert.match(rec.caution, /least bad/);
  assert.deepEqual(flags(by.B1).map((f) => f.id), ["rest"]);
});

test("the thresholds are the ones passed in", () => {
  const { state, by } = board("B1");
  charged(state, by.B1, 0, 60 * MIN, 12.6, 17);
  assert.deepEqual(flags(by.B1, DEFAULT_LIMITS), []);
  const strict = { ...DEFAULT_LIMITS, lowRestVolts: 12.7, weakMilliohm: 16 };
  assert.deepEqual(flags(by.B1, strict).map((f) => f.id), ["resistance", "rest"]);
});

test("a low reading part way through a charge is not a flag", () => {
  const { state, by } = board("B1");
  putOnCharge(state, by.B1.id, 0);
  logRest(state, by.B1.id, { volts: 12.1 }, 10 * MIN);
  assert.deepEqual(flags(by.B1), []);
});

test("coming out of the robot low is worth a look until it next goes in", () => {
  const { state, by } = board("B1");
  putInRobot(state, by.B1.id, { volts: 12.9 }, 1);
  takeOut(state, by.B1.id, { volts: 11.4 }, 2);
  assert.deepEqual(flags(by.B1).map((f) => [f.id, f.level]), [["out", "watch"]]);
  charged(state, by.B1, 3, 60 * MIN, 12.9);
  assert.equal(recommend(state, 90 * MIN).pick.weak, false, "a watch flag does not rule it out");
  putInRobot(state, by.B1.id, { volts: 12.9 }, 100 * MIN);
  assert.deepEqual(flags(by.B1), []);
});

test("batteries in the robot, resting or retired are never offered", () => {
  const { state, by } = board("B1", "B2", "B3", "B4");
  putInRobot(state, by.B1.id, { volts: 13 }, 1);
  charged(state, by.B3, 0, 60 * MIN, 13.2);
  retire(state, by.B3.id, 70 * MIN);
  charged(state, by.B4, 0, null, null);
  const rec = recommend(state, 90 * MIN);
  assert.deepEqual(rec.ranked.map((c) => c.battery.label), ["B4"]);
  assert.match(rec.caution, /Nothing is marked ready/);
  assert.match(rec.reason, /still charging · no resting voltage logged · 1 h 30 min on charge/);
});

test("with nothing to offer it says why", () => {
  const empty = defaults();
  assert.match(recommend(empty, 0).reason, /No batteries on the board/);
  const { state, by } = board("B1");
  assert.match(recommend(state, 0).reason, /Put a battery on charge/);
  retire(state, by.B1.id, 1);
  assert.match(recommend(state, 2).reason, /Every battery is retired/);
  assert.equal(recommend(state, 2).pick, null);
});

test("the board lists the robot's battery first, then candidates as ranked, then the rest", () => {
  const { state, by } = board("B1", "B2", "B3", "B4", "B5");
  putInRobot(state, by.B4.id, {}, 1);
  charged(state, by.B1, 0, 60 * MIN, 12.7);
  charged(state, by.B2, 0, 60 * MIN, 13.0);
  retire(state, by.B5.id, 2);
  assert.deepEqual(boardOrder(state, 90 * MIN).map((b) => b.label), ["B4", "B2", "B1", "B3", "B5"]);
});

test("renaming keeps labels unique; removing clears it from match logs", () => {
  const { state, by } = board("B1", "B2");
  assert.ok(renameBattery(state, by.B2.id, "b1").error);
  assert.equal(renameBattery(state, by.B2.id, "Spare").battery.label, "Spare");
  putInRobot(state, by.B1.id, { volts: 12.8, matchId: "q1" }, 1);
  takeOut(state, by.B1.id, {}, 2);
  assert.equal(removeBattery(state, by.B1.id), true);
  assert.equal(state.log.q1.batteryId, null);
  assert.equal(state.batteries.length, 1);
});
