// The event as a Markdown report: what a mentor reads on the drive home, or what goes in the
// team's notebook. Built from the same summaries the screens show, so the report cannot say
// something the app did not.
//
// Nothing is filled in. A match with no battery logged says so; a battery never measured has a
// dash where its voltage would be.

import { clock, day, stamp, volts, milliohm } from "./format.js";
import { sorted, isPlayed, longLabel, sides } from "./queue.js";
import { summary, openIssues, fixedIssues, SEVERITY_NAMES } from "./matchlog.js";
import { runSummary } from "./checklist.js";
import { STATE_NAMES, lastMilliohm, restedVolts, flags } from "./batteries.js";

/** Text that is safe inside a table cell: no pipe to split the row, no newline to end it. */
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

/** Free text as a block quote, so a note that starts with "#" or "-" stays a note. */
const quote = (text) => text.trim().split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join("\n");

export function buildReport(state, { team, now, limits }) {
  const out = [];
  const matches = sorted(state);
  const played = matches.filter((m) => isPlayed(m, now));
  const open = openIssues(state);
  const fixed = fixedIssues(state);
  const name = state.event.name.trim() || "Event";

  out.push(`# ${name} — Team ${team} pit report`, "");
  out.push(`Generated ${stamp(now)} by Catalyst Pit.`, "");

  out.push("## Summary", "");
  out.push(`- Matches on the schedule: ${matches.length}, of which ${played.length} played`);
  out.push(`- Checklist runs stamped: ${state.checklist.history.length}`);
  out.push(`- Issues: ${open.length} open, ${fixed.length} fixed`);
  out.push(`- Batteries: ${state.batteries.filter((b) => b.state !== "retired").length} in use`);
  out.push("");

  out.push("## Matches", "");
  if (!matches.length) out.push("No matches were entered.", "");
  for (const match of matches) {
    const s = summary(state, match);
    const when = match.times.start !== null ? `${day(match.times.start)} ${clock(match.times.start)}` : "time not recorded";
    out.push(`### ${longLabel(match)}`, "");

    const side = sides(match, team);
    const lines = [];
    lines.push(`- Start: ${when}${match.source === "nexus" ? " (Nexus)" : ""}`);
    if (side.alliance) {
      const partners = side.partners.length ? ` with ${side.partners.join(", ")}` : "";
      const opponents = side.opponents.length ? `, against ${side.opponents.join(", ")}` : "";
      lines.push(`- Alliance: ${side.alliance}${partners}${opponents}`);
    }
    lines.push(`- Played: ${isPlayed(match, now) ? "yes" : "not marked played"}`);
    if (s.battery) {
      const vin = s.voltsIn?.volts != null ? volts(s.voltsIn.volts) : "not measured";
      const vout = s.voltsOut?.volts != null ? volts(s.voltsOut.volts) : "not measured";
      lines.push(`- Battery: ${s.battery.label} — in ${vin}, out ${vout}`);
    } else {
      lines.push("- Battery: not logged");
    }
    if (s.run) {
      lines.push(`- Checklist: ${runSummary(s.run)}, stamped ${clock(s.run.at)}`);
      for (const missed of s.run.missed) lines.push(`  - Skipped: ${missed.text} (${missed.group})`);
    } else {
      lines.push("- Checklist: not stamped");
    }
    out.push(...lines, "");

    if (s.notes.trim()) out.push(quote(s.notes), "");
    if (s.issues.length) {
      out.push("Issues raised:", "");
      for (const issue of s.issues) {
        const fate = issue.state === "fixed" ? `fixed ${stamp(issue.fixedAt)}` : "open";
        out.push(`- **${SEVERITY_NAMES[issue.severity]}** — ${issue.title} (${fate})`);
      }
      out.push("");
    }
  }

  out.push("## Issues", "");
  if (!open.length && !fixed.length) out.push("None were raised.", "");
  if (open.length) {
    out.push("### Still open", "");
    out.push("| Severity | Issue | Raised | Detail |", "|---|---|---|---|");
    for (const i of open) out.push(`| ${SEVERITY_NAMES[i.severity]} | ${cell(i.title)} | ${cell(raised(state, i))} | ${cell(i.detail)} |`);
    out.push("");
  }
  if (fixed.length) {
    out.push("### Fixed", "");
    out.push("| Severity | Issue | Raised | Fixed | What was done |", "|---|---|---|---|---|");
    for (const i of fixed) {
      out.push(`| ${SEVERITY_NAMES[i.severity]} | ${cell(i.title)} | ${cell(raised(state, i))} | ${stamp(i.fixedAt)} | ${cell(i.fixNote)} |`);
    }
    out.push("");
  }

  out.push("## Batteries", "");
  if (!state.batteries.length) {
    out.push("None were logged.", "");
  } else {
    out.push("| Battery | State | Cycles | Rested | Resistance | Flags |", "|---|---|---|---|---|---|");
    const ordered = [...state.batteries].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    for (const b of ordered) {
      const rest = restedVolts(b);
      const mohm = lastMilliohm(b);
      const flagText = flags(b, limits).map((f) => f.text).join("; ");
      out.push(`| ${cell(b.label)} | ${STATE_NAMES[b.state]} | ${b.cycles} | ${rest === null ? "—" : volts(rest)} | ${mohm === null ? "—" : milliohm(mohm)} | ${cell(flagText)} |`);
    }
    out.push("");
  }

  out.push("## Checklist runs", "");
  if (!state.checklist.history.length) {
    out.push("None were stamped.", "");
  } else {
    out.push("| When | Match | Result |", "|---|---|---|");
    for (const run of state.checklist.history) {
      out.push(`| ${stamp(run.at)} | ${cell(run.matchLabel || "No match")} | ${runSummary(run)} |`);
    }
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function raised(state, issue) {
  const match = issue.matchId ? state.schedule.find((m) => m.id === issue.matchId) : null;
  const when = issue.openedAt !== null ? stamp(issue.openedAt) : "";
  return match ? `${longLabel(match)}, ${when}` : when;
}

/** A file name for the report: "2026-10-10-team-5805-chezy-champs-pit-report.md". */
export function reportFileName(state, team, now) {
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const slug = state.event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${date}-team-${team}${slug ? `-${slug}` : ""}-pit-report.md`;
}
