import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { defaults } from "./store.js";
import {
  STALE_AFTER, readLabel, toMs, parseNexus, mergeNexus, addMatch, editMatch, removeMatch, markPlayed,
  isPlayed, sorted, nextMatch, sides, timing, freshness, shortLabel,
} from "./queue.js";
import { toggle } from "./checklist.js";
import { countdown } from "./format.js";

const MIN = 60000;
const fixture = JSON.parse(readFileSync(new URL("../fixtures/nexus-event.json", import.meta.url), "utf8"));
const AS_OF = fixture.dataAsOfTime;

test("a match label reads the same however it was written", () => {
  for (const text of ["Qualification 12", "qual 12", "Q12", "q 12", "QM12", "Quals #12"]) {
    assert.equal(readLabel(text).id, "q12", text);
  }
  assert.deepEqual(readLabel("Q12"), { id: "q12", short: "Q12", long: "Qualification 12", order: 10024 });
  assert.equal(readLabel("Practice 3").id, "pr3");
  assert.equal(readLabel("P3").short, "P3");
  assert.equal(readLabel("Playoff 5").id, "m5");
  assert.equal(readLabel("Match 5").id, "m5");
  assert.equal(readLabel("Final 2").id, "f2");
  assert.equal(readLabel("Qualification 12 Replay").id, "q12r");
  assert.equal(readLabel("Einstein Round Robin A").id, "x-einstein-round-robin-a");
  assert.equal(readLabel("   ").id, "");
});

test("playing order by label: practice, quals in number order, playoffs, finals", () => {
  const labels = ["F1", "Q10", "M2", "Q2", "P1", "Q2 replay"];
  const ordered = [...labels].sort((a, b) => readLabel(a).order - readLabel(b).order);
  assert.deepEqual(ordered, ["P1", "Q2", "Q2 replay", "Q10", "M2", "F1"]);
});

test("times arrive as milliseconds, seconds or ISO text, and anything else is blank", () => {
  assert.equal(toMs(1791640800000), 1791640800000);
  assert.equal(toMs(1791640800), 1791640800000);
  assert.equal(toMs("1791640800000"), 1791640800000);
  assert.equal(toMs("2026-10-10T14:00:00Z"), 1791640800000);
  for (const bad of [null, undefined, "", "soon", 0, -5, NaN, {}, []]) assert.equal(toMs(bad), null);
});

test("the Nexus fixture: only this team's matches, with sides and times", () => {
  const parsed = parseNexus(fixture, 5805);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.eventKey, "demo2026");
  assert.equal(parsed.asOf, AS_OF);
  assert.equal(parsed.nowQueuing, "Qualification 11");
  assert.equal(parsed.eventMatchCount, 4);
  assert.deepEqual(parsed.matches.map((m) => m.id), ["q4", "q13", "q21"], "Q11 is not ours and is left out");

  const [q4, q13, q21] = parsed.matches;
  assert.equal(q4.alliance, "red");
  assert.equal(q4.status, "On field");
  assert.equal(q4.times.queue, 1791633660000, "an actual queue time replaces the estimate");
  assert.equal(q4.times.queueActual, true);
  assert.equal(q4.times.onFieldActual, true);

  assert.equal(q13.alliance, "blue");
  assert.equal(q13.times.queue, 1791641700000);
  assert.equal(q13.times.queueActual, false);
  assert.equal(q13.times.start, 1791642900000);

  assert.deepEqual(q21.red, ["5805", "1018"], "a null in a team list is dropped, not printed");
  assert.deepEqual(parsed.announcements, [{ text: "Lunch runs 12:00 to 13:00. Pits stay open.", at: 1791637200000 }]);
});

test("a response that is not an event is reported, never half-read", () => {
  assert.ok(parseNexus(null, 5805).error);
  assert.ok(parseNexus([], 5805).error);
  assert.ok(parseNexus({ eventKey: "x" }, 5805).error);
  assert.ok(parseNexus({ matches: "none" }, 5805).error);
});

test("a response with pieces missing leaves blanks", () => {
  const parsed = parseNexus({
    matches: [
      { label: "Qualification 7", redTeams: [5805, 1, 2], blueTeams: null },
      { label: "Qualification 8", redTeams: ["5805"], times: { estimatedQueueTime: "later", estimatedStartTime: "2026-10-10T15:00:00Z" } },
      { redTeams: ["5805"] },
      null,
      "Qualification 9",
    ],
  }, "5805");
  assert.equal(parsed.matches.length, 2);
  assert.equal(parsed.matches[0].alliance, "red", "a team number sent as a number still matches");
  assert.deepEqual(parsed.matches[0].blue, []);
  assert.deepEqual(parsed.matches[0].times, { queue: null, onDeck: null, onField: null, start: null, queueActual: false, onFieldActual: false });
  assert.equal(parsed.matches[1].times.queue, null);
  assert.equal(parsed.matches[1].times.start, 1791644400000);
  assert.equal(parsed.asOf, null);
  assert.equal(parsed.nowQueuing, "");
  assert.deepEqual(parsed.announcements, []);
});

test("a hand-entered schedule works with no network at all", () => {
  const state = defaults();
  const now = AS_OF;
  assert.ok(!addMatch(state, { label: "q13", start: now + 35 * MIN, queue: now + 15 * MIN, alliance: "blue", partners: ["1016", "1017"], opponents: ["1013"] }, 5805).error);
  assert.ok(!addMatch(state, { label: "Qual 4", start: now - 100 * MIN }, 5805).error);
  assert.match(addMatch(state, { label: "Qualification 13" }, 5805).error, /already on the schedule/);
  assert.ok(addMatch(state, { label: "" }, 5805).error);

  assert.deepEqual(sorted(state).map(shortLabel), ["Q4", "Q13"]);
  const q13 = state.schedule.find((m) => m.id === "q13");
  assert.equal(q13.label, "Qualification 13", "the label is stored in its long form");
  assert.deepEqual(sides(q13, 5805), { alliance: "blue", partners: ["1016", "1017"], opponents: ["1013"] });
  assert.deepEqual(sides(state.schedule.find((m) => m.id === "q4"), 5805), { alliance: null, partners: [], opponents: [] });

  // A start time passing proves nothing: Q4 is still next until someone says it was played.
  assert.equal(nextMatch(state, now).id, "q4");
  markPlayed(state, "q4", true, now);
  assert.equal(nextMatch(state, now).id, "q13");
  markPlayed(state, "q13", true, now);
  assert.equal(nextMatch(state, now), null);
  markPlayed(state, "q13", false, now);
  assert.equal(nextMatch(state, now).id, "q13");
});

test("time until queue comes from a real queue time, and falls back to the start by name", () => {
  const state = defaults();
  const now = AS_OF;
  addMatch(state, { label: "Q1", start: now + 35 * MIN, queue: now + 15 * MIN }, 5805);
  addMatch(state, { label: "Q2", start: now + 50 * MIN }, 5805);
  addMatch(state, { label: "Q3" }, 5805);
  const [q1, q2, q3] = sorted(state);

  const t1 = timing(q1, now);
  assert.deepEqual([t1.kind, t1.ms, t1.late, t1.estimate], ["queue", 15 * MIN, false, false]);
  assert.equal(countdown(t1.ms), "15:00");

  const t2 = timing(q2, now);
  assert.deepEqual([t2.kind, t2.ms], ["start", 50 * MIN], "no queue time is derived from the start");

  assert.equal(timing(q3, now).kind, "none");

  const late = timing(q1, now + 19 * MIN);
  assert.deepEqual([late.kind, late.late, late.ms], ["queue", true, 4 * MIN]);
});

test("Nexus timing: an estimate counts down, a live status is shown in Nexus's words", () => {
  const state = defaults();
  mergeNexus(state, parseNexus(fixture, 5805), AS_OF);
  const q13 = state.schedule.find((m) => m.id === "q13");
  const t = timing(q13, AS_OF);
  assert.deepEqual([t.kind, t.ms, t.estimate], ["queue", 15 * MIN, true]);

  const q4 = state.schedule.find((m) => m.id === "q4");
  assert.deepEqual([timing(q4, AS_OF).kind, timing(q4, AS_OF).text], ["status", "On field"]);

  q13.status = "Now queuing";
  assert.deepEqual([timing(q13, AS_OF).kind, timing(q13, AS_OF).text], ["status", "Now queuing"]);
});

test("Nexus says when a match is behind us; the next one follows", () => {
  const state = defaults();
  mergeNexus(state, parseNexus(fixture, 5805), AS_OF);
  const q4 = state.schedule.find((m) => m.id === "q4");
  // Q4 actually took the field 103 minutes before the data's timestamp.
  assert.equal(isPlayed(q4, AS_OF), true);
  assert.equal(isPlayed(q4, q4.times.onField + 5 * MIN), false, "five minutes after taking the field it is still being played");
  assert.equal(nextMatch(state, AS_OF).id, "q13");
});

test("Nexus takes over a hand-entered schedule without doubling it or losing what hangs off it", () => {
  const state = defaults();
  addMatch(state, { label: "Q13", start: AS_OF + 60 * MIN }, 5805);
  addMatch(state, { label: "Q99", start: AS_OF + 600 * MIN }, 5805);
  markPlayed(state, "q13", true, AS_OF);
  toggle(state.checklist, "q13", "mechanical-1", AS_OF);
  state.log.q13 = { batteryId: "b1", notes: "typed before Nexus" };

  const result = mergeNexus(state, parseNexus(fixture, 5805), AS_OF + MIN);
  assert.deepEqual(result, { added: 2, updated: 1 });
  assert.equal(state.schedule.filter((m) => m.id === "q13").length, 1);

  const q13 = state.schedule.find((m) => m.id === "q13");
  assert.equal(q13.source, "nexus");
  assert.equal(q13.times.start, 1791642900000, "Nexus's time replaces the typed one");
  assert.equal(q13.alliance, "blue");
  assert.equal(q13.played, true, "the played mark survives");
  assert.equal(state.log.q13.notes, "typed before Nexus");
  assert.ok(state.checklist.drafts.q13);
  assert.ok(state.schedule.some((m) => m.id === "q99"), "a match Nexus does not list is left alone");

  assert.deepEqual(state.nexus, {
    eventKey: "demo2026", fetchedAt: AS_OF + MIN, asOf: AS_OF, nowQueuing: "Qualification 11",
    announcements: [{ text: "Lunch runs 12:00 to 13:00. Pits stay open.", at: 1791637200000 }],
  });

  // A second fetch with later estimates moves the times and adds nothing.
  const later = structuredClone(fixture);
  later.matches[2].times.estimatedQueueTime += 10 * MIN;
  assert.deepEqual(mergeNexus(state, parseNexus(later, 5805), AS_OF + 2 * MIN), { added: 0, updated: 3 });
  assert.equal(state.schedule.find((m) => m.id === "q13").times.queue, 1791641700000 + 10 * MIN);
});

test("Nexus data is called stale once it is old", () => {
  assert.equal(freshness(null, 5), null);
  const nexus = { fetchedAt: 1000 };
  assert.deepEqual(freshness(nexus, 1000 + MIN), { age: MIN, stale: false, at: 1000 });
  assert.equal(freshness(nexus, 1000 + STALE_AFTER + 1).stale, true);
});

test("a hand-entered match can be corrected, and removed with its ticks", () => {
  const state = defaults();
  addMatch(state, { label: "Q5", start: 1000 }, 5805);
  editMatch(state, "q5", { start: 2000, queue: 1500, alliance: "red", partners: ["11"], opponents: ["12", "13"] }, 5805);
  const q5 = state.schedule[0];
  assert.deepEqual([q5.times.start, q5.times.queue], [2000, 1500]);
  assert.deepEqual(q5.red, ["5805", "11"]);
  assert.deepEqual(q5.blue, ["12", "13"]);
  editMatch(state, "q5", { queue: null }, 5805);
  assert.equal(q5.times.queue, null);
  assert.deepEqual(q5.red, ["5805", "11"], "fields that were not sent are not touched");

  toggle(state.checklist, "q5", "mechanical-1", 1);
  state.log.q5 = { batteryId: null, notes: "kept" };
  assert.equal(removeMatch(state, "q5"), true);
  assert.deepEqual(state.schedule, []);
  assert.deepEqual(state.checklist.drafts, {});
  assert.equal(state.log.q5.notes, "kept", "what was written about it is not thrown away");
});
