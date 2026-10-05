// The match log and the issue list.
//
// A match's log is small on purpose: which battery went in, what the checklist said, what was
// noticed. The issues are the part that outlives the match. One raised after Q12 is open until
// someone marks it fixed, and until then it is shown above the checklist for every match that
// follows — an open issue is, in effect, an extra line on the list.

import { nextId } from "./store.js";
import { lastRunFor } from "./checklist.js";

export const SEVERITIES = ["high", "medium", "low"];

export const SEVERITY_NAMES = {
  high: "Must fix",
  medium: "Should fix",
  low: "Watch",
};

/** The log entry for a match, made on first use. */
export function entry(state, matchId) {
  return (state.log[matchId] ??= { batteryId: null, notes: "" });
}

export function setNotes(state, matchId, notes) {
  entry(state, matchId).notes = typeof notes === "string" ? notes : "";
}

export function setBattery(state, matchId, batteryId) {
  entry(state, matchId).batteryId = batteryId || null;
}

const clean = (text) => (typeof text === "string" ? text.trim() : "");

/** Raise an issue, against a match or against none. */
export function addIssue(state, { title, detail = "", severity = "medium", matchId = null }, now) {
  const value = clean(title);
  if (!value) return { error: "Say what is wrong in a few words." };
  const issue = {
    id: nextId(state, "i"),
    title: value,
    detail: clean(detail),
    severity: SEVERITIES.includes(severity) ? severity : "medium",
    state: "open",
    openedAt: now,
    matchId: matchId || null,
    fixedAt: null,
    fixNote: "",
  };
  state.issues.push(issue);
  return { issue };
}

export function editIssue(state, id, { title, detail, severity }) {
  const issue = state.issues.find((i) => i.id === id);
  if (!issue) return { error: "No such issue." };
  if (title !== undefined) {
    const value = clean(title);
    if (!value) return { error: "Say what is wrong in a few words." };
    issue.title = value;
  }
  if (detail !== undefined) issue.detail = clean(detail);
  if (severity !== undefined && SEVERITIES.includes(severity)) issue.severity = severity;
  return { issue };
}

/** Mark an issue fixed, with an optional note on what was done. */
export function fixIssue(state, id, fixNote, now) {
  const issue = state.issues.find((i) => i.id === id);
  if (!issue) return false;
  issue.state = "fixed";
  issue.fixedAt = now;
  issue.fixNote = clean(fixNote);
  return true;
}

/** It came back. The fix note is kept: what was tried is worth knowing the second time. */
export function reopenIssue(state, id) {
  const issue = state.issues.find((i) => i.id === id);
  if (!issue) return false;
  issue.state = "open";
  issue.fixedAt = null;
  return true;
}

export function removeIssue(state, id) {
  const before = state.issues.length;
  state.issues = state.issues.filter((i) => i.id !== id);
  return state.issues.length < before;
}

const bySeverityThenAge = (a, b) =>
  SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.openedAt ?? 0) - (b.openedAt ?? 0);

/** Everything still open, worst first and oldest first within that. This is what carries forward. */
export function openIssues(state) {
  return state.issues.filter((i) => i.state === "open").sort(bySeverityThenAge);
}

export function fixedIssues(state) {
  return state.issues.filter((i) => i.state === "fixed").sort((a, b) => (b.fixedAt ?? 0) - (a.fixedAt ?? 0));
}

/** The issues raised against one match, open or not. */
export function issuesFor(state, matchId) {
  return state.issues.filter((i) => i.matchId === matchId).sort(bySeverityThenAge);
}

/**
 * Everything known about one match, gathered for a screen or a report: the battery and its
 * readings in and out, the checklist's last stamped run, the notes and the issues raised.
 * Anything not recorded is null or empty, never filled in.
 */
export function summary(state, match) {
  const log = state.log[match.id] ?? { batteryId: null, notes: "" };
  const battery = log.batteryId ? state.batteries.find((b) => b.id === log.batteryId) || null : null;
  const readings = battery ? battery.readings.filter((r) => r.matchId === match.id) : [];
  const last = (kind) => [...readings].reverse().find((r) => r.kind === kind) || null;
  return {
    match,
    battery,
    voltsIn: last("in"),
    voltsOut: last("out"),
    run: lastRunFor(state.checklist, match.id),
    notes: log.notes,
    issues: issuesFor(state, match.id),
  };
}

/** Whether anything at all has been recorded against a match. */
export function hasLog(state, match) {
  const s = summary(state, match);
  return Boolean(s.battery || s.run || s.notes.trim() || s.issues.length);
}
