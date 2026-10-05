// Made-up events for looking at the interface. Development only: nothing here ships in the app,
// which starts empty and shows only what its crew enters. The team numbers other than 5805 are
// placeholders and the readings are invented.
//
// Each state is built by calling the same functions the app calls, with times placed around "now",
// so a fixture cannot drift into a shape the app would never produce, and the countdowns on a
// screenshot are counting to something.

import { readFileSync } from "node:fs";

import { defaults } from "../src/core/store.js";
import { addBattery, putOnCharge, markReady, putInRobot, takeOut, retire } from "../src/core/batteries.js";
import { addMatch, markPlayed, parseNexus, mergeNexus } from "../src/core/queue.js";
import { toggle, stampRun } from "../src/core/checklist.js";
import { addIssue, fixIssue, setNotes } from "../src/core/matchlog.js";

const MIN = 60_000;

const SETTINGS = { team: 5805, eventKey: "", hasNexusKey: false, robotLink: true, lowRestVolts: 12.5, weakMilliohm: 20 };
const NO_ROBOT = { enabled: true, connected: false, address: "", volts: null, topic: null };

/** An afternoon at an event, entered by hand: two matches played, a third coming up. */
function afternoon(now) {
  const S = defaults();
  S.event = { name: "Fixture Regional", startedAt: now - 300 * MIN };
  const at = (minutes) => now + minutes * MIN;

  for (const label of ["B1", "B2", "B3", "B4", "B5", "B6"]) addBattery(S, label, at(-290));
  const id = (label) => S.batteries.find((b) => b.label === label).id;

  addMatch(S, { label: "Q4", start: at(-150), queue: at(-170), alliance: "red", partners: ["1001", "1003"], opponents: ["1004", "1005", "1006"] }, 5805);
  addMatch(S, { label: "Q13", start: at(-55), queue: at(-75), alliance: "blue", partners: ["1016", "1017"], opponents: ["1013", "1014", "1015"] }, 5805);
  addMatch(S, { label: "Q21", start: at(38), queue: at(18), alliance: "red", partners: ["1018", "1022"], opponents: ["1019", "1020", "1021"] }, 5805);
  addMatch(S, { label: "Q30", start: at(131), alliance: "blue", partners: ["1030", "1031"], opponents: ["1032", "1033", "1034"] }, 5805);
  addMatch(S, { label: "Q38", start: at(214) }, 5805);

  const everything = () => S.checklist.groups.flatMap((g) => g.items);

  // Q4: a clean run on B3.
  putOnCharge(S, id("B3"), at(-280));
  markReady(S, id("B3"), { volts: 12.93, mohm: 12 }, at(-190));
  for (const item of everything()) toggle(S.checklist, "q4", item.id, at(-182));
  stampRun(S, "q4", "Qualification 4", at(-176));
  putInRobot(S, id("B3"), { volts: 12.91, matchId: "q4" }, at(-175));
  takeOut(S, id("B3"), { volts: 12.08 }, at(-138));
  markPlayed(S, "q4", true, at(-138));
  setNotes(S, "q4", "Auto scored all three. Intake was slow to pick up off the wall.");
  putOnCharge(S, id("B3"), at(-136));

  // Q13: two checks skipped, the battery came back low, and it turned up three issues.
  putOnCharge(S, id("B5"), at(-270));
  markReady(S, id("B5"), { volts: 12.88, mohm: 15 }, at(-95));
  for (const item of everything()) toggle(S.checklist, "q13", item.id, at(-86));
  toggle(S.checklist, "q13", "software-6", at(-85));
  toggle(S.checklist, "q13", "drive-team-2", at(-85));
  stampRun(S, "q13", "Qualification 13", at(-80));
  putInRobot(S, id("B5"), { volts: 12.86, matchId: "q13" }, at(-79));
  takeOut(S, id("B5"), { volts: 11.52 }, at(-44));
  markPlayed(S, "q13", true, at(-44));
  setNotes(S, "q13", "Browned out once near the end while shooting on the move.\nDrivers say the front left feels notchy.");
  const belt = addIssue(S, { title: "Intake belt skipping under load", severity: "medium", matchId: "q13" }, at(-42)).issue;
  addIssue(S, { title: "Front-left module grinding when turning", severity: "high", matchId: "q13", detail: "Worse turning left. Check the bevel gear and the wheel bolts." }, at(-41));
  addIssue(S, { title: "Bumper number peeling on the blue set", severity: "low", matchId: "q13" }, at(-40));
  fixIssue(S, belt.id, "Re-tensioned, replaced one idler", at(-22));

  // The board now: three candidates, one of them weak, and one battery retired.
  putOnCharge(S, id("B1"), at(-200));
  markReady(S, id("B1"), { volts: 12.96, mohm: 13 }, at(-35));
  putOnCharge(S, id("B2"), at(-240));
  markReady(S, id("B2"), { volts: 12.71, mohm: 16 }, at(-60));
  putOnCharge(S, id("B4"), at(-230));
  markReady(S, id("B4"), { volts: 13.02, mohm: 24 }, at(-70));
  retire(S, id("B6"), at(-260));
  S.batteries.find((b) => b.label === "B6").note = "Swollen case";

  // Q21: part way through the checklist.
  for (const item of everything().slice(0, 9)) toggle(S.checklist, "q21", item.id, at(-4));

  return S;
}

/** The same afternoon one step on: B1 has gone in for Q21 and the checklist is done. */
function inRobot(now) {
  const S = afternoon(now);
  const id = S.batteries.find((b) => b.label === "B1").id;
  for (const item of S.checklist.groups.flatMap((g) => g.items).slice(9)) toggle(S.checklist, "q21", item.id, now - 3 * MIN);
  stampRun(S, "q21", "Qualification 21", now - 2 * MIN);
  putInRobot(S, id, { volts: 12.95, mohm: 13, matchId: "q21" }, now - 2 * MIN);
  return S;
}

/** Nexus's fixture response with its times moved so "now" falls where the data's own timestamp is. */
export function nexusResponse(now) {
  const raw = JSON.parse(readFileSync(new URL("../src/fixtures/nexus-event.json", import.meta.url), "utf8"));
  const shift = now - raw.dataAsOfTime;
  const move = (value) => (typeof value === "number" ? value + shift : value);
  raw.dataAsOfTime = now;
  for (const match of raw.matches) for (const key of Object.keys(match.times)) match.times[key] = move(match.times[key]);
  for (const a of raw.announcements) a.postedTime = move(a.postedTime);
  delete raw._about;
  return raw;
}

/**
 * The fixtures, by name. Each is what the fake backend starts from: the stored event (`null` for a
 * first run), the settings, what a Nexus fetch returns (or
 * `{ error }` for one that fails), and what the robot link reports.
 */
export const FIXTURES = {
  // A first launch: nothing on disk.
  empty: () => ({ data: null, settings: SETTINGS, robot: NO_ROBOT, nexus: null }),

  // No network: a schedule typed in by hand.
  manual: (now) => ({ data: afternoon(now), settings: SETTINGS, robot: NO_ROBOT, nexus: null }),

  // A battery in the robot, and the robot on the network publishing its voltage.
  robot: (now) => ({
    data: inRobot(now),
    settings: SETTINGS,
    robot: { enabled: true, connected: true, address: "10.58.5.2", volts: 12.61, topic: "/Catalyst/Status/BatteryVolts" },
    nexus: null,
  }),

  // Nexus set up: the app fetches the fixture response at launch and merges it into an empty event.
  nexus: (now) => {
    const S = defaults();
    S.event = { name: "Fixture Regional", startedAt: now - 300 * MIN };
    for (const label of ["B1", "B2"]) addBattery(S, label, now - 200 * MIN);
    return { data: S, settings: { ...SETTINGS, eventKey: "demo2026", hasNexusKey: true }, robot: NO_ROBOT, nexus: nexusResponse(now) };
  },

  // Nexus set up but unreachable, over a schedule it sent fourteen minutes ago.
  offline: (now) => {
    const S = defaults();
    S.event = { name: "Fixture Regional", startedAt: now - 300 * MIN };
    const then = now - 14 * MIN;
    mergeNexus(S, parseNexus(nexusResponse(then), 5805), then);
    return {
      data: S,
      settings: { ...SETTINGS, eventKey: "demo2026", hasNexusKey: true },
      robot: NO_ROBOT,
      nexus: { error: "Could not reach Nexus. The schedule already here is unchanged." },
    };
  },

  // A data file from a newer build: the app must refuse it and change nothing.
  newer: () => ({ data: { schema: 99, batteries: [] }, settings: SETTINGS, robot: NO_ROBOT, nexus: null }),
};
