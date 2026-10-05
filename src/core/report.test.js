import test from "node:test";
import assert from "node:assert/strict";

import { defaults } from "./store.js";
import { addBattery, putOnCharge, markReady, putInRobot, takeOut, DEFAULT_LIMITS } from "./batteries.js";
import { addMatch, markPlayed } from "./queue.js";
import { toggle, stampRun } from "./checklist.js";
import { addIssue, fixIssue, reopenIssue, editIssue, removeIssue, openIssues, fixedIssues, issuesFor, setNotes, summary, hasLog } from "./matchlog.js";
import { buildReport, reportFileName } from "./report.js";
import { stamp, clock } from "./format.js";

const MIN = 60000;
// Local noon on a fixed day, so the printed times are the same in every time zone the test runs in.
const T0 = new Date(2026, 9, 10, 12, 0, 0, 0).getTime();

function event() {
  const state = defaults();
  state.event.name = "Chezy Champs";
  addBattery(state, "B1", T0);
  addBattery(state, "B2", T0);
  putOnCharge(state, "b1", T0);
  markReady(state, "b1", { volts: 12.94, mohm: 13 }, T0 + 30 * MIN);
  addMatch(state, { label: "Q4", start: T0 + 60 * MIN, alliance: "red", partners: ["254", "1678"], opponents: ["971"] }, 5805);
  addMatch(state, { label: "Q13", start: T0 + 180 * MIN }, 5805);

  for (const group of state.checklist.groups) for (const item of group.items) toggle(state.checklist, "q4", item.id, T0 + 40 * MIN);
  toggle(state.checklist, "q4", "electrical-4", T0 + 41 * MIN);       // unticked again: the radio check was skipped
  stampRun(state, "q4", "Qualification 4", T0 + 45 * MIN);
  putInRobot(state, "b1", { volts: 12.9, matchId: "q4" }, T0 + 46 * MIN);
  takeOut(state, "b1", { volts: 12.05 }, T0 + 75 * MIN);
  markPlayed(state, "q4", true, T0 + 75 * MIN);
  setNotes(state, "q4", "Shooter fed fine.\n# not a heading | not a column");
  return state;
}

test("issues carry forward until they are fixed", () => {
  const state = event();
  const a = addIssue(state, { title: "Intake belt skipping", severity: "medium", matchId: "q4" }, T0 + 80 * MIN).issue;
  const b = addIssue(state, { title: "Swerve module 2 grinding", severity: "high", matchId: "q4", detail: "front right" }, T0 + 81 * MIN).issue;
  const c = addIssue(state, { title: "Bumper number peeling", severity: "low" }, T0 + 82 * MIN).issue;
  assert.ok(addIssue(state, { title: "  " }, T0).error);

  assert.deepEqual(openIssues(state).map((i) => i.id), [b.id, a.id, c.id], "worst first");
  assert.deepEqual(issuesFor(state, "q4").map((i) => i.id), [b.id, a.id]);
  assert.deepEqual(issuesFor(state, "q13"), [], "raised against Q4, but still open for Q13:");
  assert.equal(openIssues(state).length, 3);

  fixIssue(state, a.id, "  re-tensioned ", T0 + 100 * MIN);
  assert.deepEqual(openIssues(state).map((i) => i.id), [b.id, c.id]);
  assert.deepEqual(fixedIssues(state).map((i) => [i.id, i.fixNote, i.fixedAt]), [[a.id, "re-tensioned", T0 + 100 * MIN]]);

  reopenIssue(state, a.id);
  assert.equal(openIssues(state).length, 3);
  assert.equal(state.issues.find((i) => i.id === a.id).fixNote, "re-tensioned", "what was tried is kept");

  assert.ok(!editIssue(state, c.id, { severity: "high", title: "Bumper number gone" }).error);
  assert.ok(editIssue(state, c.id, { title: "" }).error);
  assert.equal(openIssues(state)[1].title, "Bumper number gone", "high now, but raised after the other high one");
  assert.equal(removeIssue(state, c.id), true);
  assert.equal(state.issues.length, 2);
});

test("a match summary gathers what was recorded and nothing else", () => {
  const state = event();
  const q4 = summary(state, state.schedule.find((m) => m.id === "q4"));
  assert.equal(q4.battery.label, "B1");
  assert.equal(q4.voltsIn.volts, 12.9);
  assert.equal(q4.voltsOut.volts, 12.05);
  assert.equal(q4.run.done, q4.run.total - 1);
  assert.equal(q4.run.missed.length, 1);

  const q13match = state.schedule.find((m) => m.id === "q13");
  const q13 = summary(state, q13match);
  assert.deepEqual([q13.battery, q13.voltsIn, q13.voltsOut, q13.run, q13.notes, q13.issues], [null, null, null, null, "", []]);
  assert.equal(hasLog(state, q13match), false);
  assert.equal(hasLog(state, q4.match), true);
});

test("the report says what happened, in order, and nothing it was not told", () => {
  const state = event();
  const fixedOne = addIssue(state, { title: "Intake belt skipping", severity: "medium", matchId: "q4" }, T0 + 80 * MIN).issue;
  addIssue(state, { title: "Module 2 | grinding", severity: "high", matchId: "q4", detail: "front right\nwhen turning" }, T0 + 81 * MIN);
  fixIssue(state, fixedOne.id, "re-tensioned", T0 + 100 * MIN);

  const now = T0 + 120 * MIN;
  const md = buildReport(state, { team: 5805, now, limits: DEFAULT_LIMITS });
  const total = state.checklist.history[0].total;

  assert.ok(md.startsWith("# Chezy Champs — Team 5805 pit report\n"));
  assert.ok(md.includes(`Generated ${stamp(now)} by Catalyst Pit.`));
  assert.ok(md.includes("- Matches on the schedule: 2, of which 1 played"));
  assert.ok(md.includes("- Issues: 1 open, 1 fixed"));

  assert.ok(md.indexOf("### Qualification 4") < md.indexOf("### Qualification 13"), "matches in playing order");
  assert.ok(md.includes("- Alliance: red with 254, 1678, against 971"));
  assert.ok(md.includes("- Battery: B1 — in 12.90 V, out 12.05 V"));
  assert.ok(md.includes(`- Checklist: ${total - 1} of ${total}, 1 skipped, stamped ${clock(T0 + 45 * MIN)}`));
  assert.ok(md.includes("  - Skipped: Radio powered, both ends of its cables latched (Electrical)"));
  assert.ok(md.includes("> Shooter fed fine.\n> # not a heading | not a column"), "notes are quoted, so they cannot become structure");
  assert.ok(md.includes("- **Must fix** — Module 2 | grinding (open)"));
  assert.ok(md.includes(`- **Should fix** — Intake belt skipping (fixed ${stamp(T0 + 100 * MIN)})`));

  // The match nothing was recorded for says so rather than leaving a gap that reads as "fine".
  const q13 = md.slice(md.indexOf("### Qualification 13"), md.indexOf("## Issues"));
  assert.ok(q13.includes("- Played: not marked played"));
  assert.ok(q13.includes("- Battery: not logged"));
  assert.ok(q13.includes("- Checklist: not stamped"));
  assert.ok(!q13.includes("Alliance"), "no alliance was entered, so none is printed");

  assert.ok(md.includes(`| Must fix | Module 2 \\| grinding | Qualification 4, ${stamp(T0 + 81 * MIN)} | front right when turning |`), "a pipe or a newline cannot break a table");
  assert.ok(md.includes(`| Should fix | Intake belt skipping | Qualification 4, ${stamp(T0 + 80 * MIN)} | ${stamp(T0 + 100 * MIN)} | re-tensioned |`));

  assert.ok(md.includes("| B1 | Resting | 1 | — | 13 mΩ |  |"), "B1 came out, so its old resting voltage is not repeated");
  assert.ok(md.includes("| B2 | Resting | 0 | — | — |  |"));
  assert.ok(md.includes(`| ${stamp(T0 + 45 * MIN)} | Qualification 4 | ${total - 1} of ${total}, 1 skipped |`));
  assert.ok(md.endsWith("\n") && !md.endsWith("\n\n"));
  assert.ok(!/\n{3,}/.test(md));
});

test("an empty event still makes an honest report", () => {
  const md = buildReport(defaults(), { team: 5805, now: T0, limits: DEFAULT_LIMITS });
  assert.ok(md.startsWith("# Event — Team 5805 pit report\n"));
  assert.ok(md.includes("No matches were entered."));
  assert.ok(md.includes("None were raised."));
  assert.ok(md.includes("None were logged."));
  assert.ok(md.includes("None were stamped."));
});

test("the report's file name is dated and safe on disk", () => {
  const state = event();
  assert.equal(reportFileName(state, 5805, T0), "2026-10-10-team-5805-chezy-champs-pit-report.md");
  state.event.name = "  Río / Regional: 2026? ";
  assert.equal(reportFileName(state, 5805, T0), "2026-10-10-team-5805-r-o-regional-2026-pit-report.md");
  state.event.name = "";
  assert.equal(reportFileName(state, 5805, T0), "2026-10-10-team-5805-pit-report.md");
});
