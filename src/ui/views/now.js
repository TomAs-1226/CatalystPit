// Now: the screen left up between matches. Four questions, each answered from across the pit —
// when are we up, is the checklist done, which battery, is anything still broken.

import { esc, btn, sideTag, meter, teams, plural } from "../dom.js";
import { clock, countdown, span } from "../../core/format.js";
import { nextMatch, timing, sides, shortLabel, longLabel, freshness, sorted, isPlayed, markPlayed } from "../../core/queue.js";
import { progress, lastRunFor, runSummary } from "../../core/checklist.js";
import { recommend, inRobot, lastReading, flags } from "../../core/batteries.js";
import { openIssues, SEVERITY_NAMES } from "../../core/matchlog.js";

/** The countdown block for a match: the big figure, what it counts to, and where the time is from. */
export function countBlock(ctx, match) {
  const now = ctx.now();
  const t = timing(match, now);
  const fresh = freshness(ctx.S.nexus, now);

  let source = "";
  let sourceLevel = "";
  if (match.source === "nexus") {
    if (ctx.nexus.error) {
      source = fresh ? `Nexus could not be reached. Times are from ${clock(fresh.at)}.` : "Nexus could not be reached.";
      sourceLevel = "warn";
    } else if (fresh?.stale) {
      source = `Nexus data is ${span(fresh.age)} old.`;
      sourceLevel = "warn";
    } else if (fresh) {
      source = `From Nexus, updated ${clock(fresh.at)}`;
    }
  }

  if (t.kind === "status") {
    const queued = match.times.queue !== null && match.times.queueActual ? `Queued at ${clock(match.times.queue)}` : "According to Nexus";
    return `<div class="count"><div class="count-n words">${esc(t.text)}</div><div class="count-what">${esc(queued)}</div>${source ? `<div class="count-src" data-level="${sourceLevel}">${esc(source)}</div>` : ""}</div>`;
  }

  if (t.kind === "none") {
    return `<div class="count"><div class="count-n words">No time entered</div><div class="count-what">Give this match a start or queue time to see a countdown.</div></div>`;
  }

  const what = t.kind === "queue"
    ? (t.late ? "past the queue time" : t.estimate ? "until queue, by Nexus's estimate" : "until queue")
    : (t.late ? "past the scheduled start" : "until the scheduled start");
  let note = source;
  let noteLevel = sourceLevel;
  if (!note) {
    if (t.kind === "start" && !t.late) note = "No queue time is known for this match.";
    else if (t.late && match.source !== "nexus") { note = "Events run late. Mark it played once it has been."; }
    else if (t.kind === "queue") note = "Queue time entered by hand.";
  }
  return `<div class="count" data-late="${t.late}">
    <div class="count-n" data-count-to="${t.at}" data-count-dir="${t.late ? "up" : "down"}">${countdown(t.ms)}</div>
    <div class="count-what">${what}</div>
    ${note ? `<div class="count-src" data-level="${noteLevel}">${esc(note)}</div>` : ""}
  </div>`;
}

function nextTile(ctx) {
  const now = ctx.now();
  const { S, settings } = ctx;
  const match = nextMatch(S, now);

  if (!match) {
    const any = S.schedule.length > 0;
    const configured = settings.hasNexusKey && settings.eventKey;
    return `<section class="tile next"><div class="tile-label"><span>Next match</span></div>
      <div class="empty" style="margin:auto 0">
        <h2>${any ? "No matches left on the schedule" : "No schedule yet"}</h2>
        <p>${any
          ? "Every match here is marked played. Add the next one when it is announced."
          : configured
            ? "Nexus has not sent any matches for this team yet. You can also add them by hand."
            : "Add your matches by hand from the printed schedule, or connect Nexus in Settings to have them filled in and kept on time."}</p>
        <div class="tile-actions">
          ${btn("Add a match", "match-add", { cls: "primary", ico: "plus" })}
          ${any || configured ? "" : btn("Set up Nexus", "go", { d: { view: "settings" } })}
        </div>
      </div></section>`;
  }

  const side = sides(match, settings.team);
  const facts = [];
  if (match.times.queue !== null) facts.push(`<span>Queue<b>${clock(match.times.queue)}</b></span>`);
  if (match.times.start !== null) facts.push(`<span>Start<b>${clock(match.times.start)}</b></span>`);
  if (side.partners.length) facts.push(`<span>With<b>${teams(side.partners)}</b></span>`);
  if (side.opponents.length) facts.push(`<span>Against<b>${teams(side.opponents)}</b></span>`);

  const after = sorted(S).filter((m) => !isPlayed(m, now) && m.id !== match.id);
  const then = after.length ? `Then ${shortLabel(after[0])}${after[0].times.start !== null ? ` at ${clock(after[0].times.start)}` : ""}` : "Last match on the schedule";

  return `<section class="tile next">
    <div class="tile-label"><span>Next match</span><span>${esc(then)}</span></div>
    <div class="next-top">
      <span class="next-label">${esc(shortLabel(match))}</span>
      ${sideTag(side.alliance)}
      <span class="next-long">${esc(longLabel(match))}</span>
    </div>
    ${countBlock(ctx, match)}
    ${facts.length ? `<div class="next-facts">${facts.join("")}</div>` : ""}
    <div class="tile-actions">
      ${btn("Match log", "go", { d: { view: "log", arg: match.id } })}
      ${btn("Mark played", "match-played", { cls: "ghost", d: { id: match.id, played: "true" } })}
    </div>
  </section>`;
}

function checklistTile(ctx) {
  const now = ctx.now();
  const match = nextMatch(ctx.S, now);
  const id = match?.id ?? null;
  const p = progress(ctx.S.checklist, id);
  const run = lastRunFor(ctx.S.checklist, id);
  const forWhat = match ? `Checklist · ${shortLabel(match)}` : "Checklist";

  let value;
  let sub;
  if (!p.total) {
    value = "The list is empty";
    sub = "Add items from the checklist screen.";
  } else if (p.started || !run) {
    value = `${p.done} of ${p.total}`;
    sub = p.complete ? "All ticked. Stamp it to record the run." : p.started ? `${p.total - p.done} to go` : match ? "Not started for this match" : "Not started";
  } else {
    value = "Stamped";
    sub = `${runSummary(run)} at ${clock(run.at)}`;
  }
  const showMeter = p.total && (p.started || !run);
  return `<button class="tile" data-act="go" data-view="checklist">
    <div class="tile-label"><span>${esc(forWhat)}</span></div>
    <div class="tile-value">${esc(value)}</div>
    ${showMeter ? `<div style="margin-top:14px">${meter(`now-cl-${id}`, p.done, p.total)}</div>` : ""}
    <div class="tile-sub">${esc(sub)}</div>
  </button>`;
}

function batteryTile(ctx) {
  const now = ctx.now();
  const { S, limits, robot } = ctx;
  const current = inRobot(S);
  const rec = recommend(S, now, limits);

  let value;
  const lines = [];
  if (!S.batteries.length) {
    value = "No batteries yet";
    lines.push("Add each one by the label written on it.");
  } else if (current) {
    const went = lastReading(current, "in");
    const wentIn = went && went.at >= current.stateSince && went.volts !== null ? ` · went in at ${went.volts.toFixed(2)} V` : "";
    value = `${current.label} in the robot`;
    lines.push(`Since ${clock(current.stateSince)}${wentIn}`);
    if (rec.pick) lines.push(`Next: ${rec.pick.battery.label} · ${rec.reason}`);
    else lines.push(rec.reason);
  } else if (rec.pick) {
    value = `Take ${rec.pick.battery.label}`;
    lines.push(rec.reason);
  } else {
    value = "Nothing to take";
    lines.push(rec.reason);
  }

  const caution = rec.pick && rec.caution ? `<div class="tile-sub warn-text">${esc(rec.caution)}</div>` : "";
  const weak = S.batteries.filter((b) => flags(b, limits).some((f) => f.level === "weak"));
  const weakLine = weak.length ? `<div class="tile-sub warn-text">${esc(plural(weak.length, "battery is", "batteries are"))} flagged: ${esc(weak.map((b) => b.label).join(", "))}</div>` : "";
  const robotLine = robot?.volts != null ? `<div class="tile-sub">The robot reads ${robot.volts.toFixed(2)} V now</div>` : "";

  return `<button class="tile" data-act="go" data-view="batteries">
    <div class="tile-label"><span>Battery</span></div>
    <div class="tile-value">${esc(value)}</div>
    ${lines.map((l) => `<div class="tile-sub">${esc(l)}</div>`).join("")}
    ${caution}${weakLine}${robotLine}
  </button>`;
}

function issuesTile(ctx) {
  const open = openIssues(ctx.S);
  const top = open.slice(0, 3)
    .map((i) => `<div class="issue-mini"><span class="sev" data-sev="${i.severity}">${esc(SEVERITY_NAMES[i.severity])}</span><span>${esc(i.title)}</span></div>`)
    .join("");
  const more = open.length > 3 ? `<div class="tile-sub">and ${open.length - 3} more</div>` : "";
  return `<button class="tile" data-act="go" data-view="log" data-arg="issues">
    <div class="tile-label"><span>Open issues</span></div>
    <div class="tile-value">${open.length ? esc(`${open.length} open`) : "Nothing open"}</div>
    ${open.length ? `<div style="margin-top:8px">${top}</div>${more}` : `<div class="tile-sub">Issues raised after a match stay here until they are fixed.</div>`}
  </button>`;
}

export function render(ctx) {
  return `<div class="now-grid" style="padding-top:8px">
    ${nextTile(ctx)}
    <div class="now-side">${checklistTile(ctx)}${batteryTile(ctx)}${issuesTile(ctx)}</div>
  </div>`;
}

export const actions = {
  "match-played": (ctx, el) => {
    const played = el.dataset.played === "true";
    const match = ctx.S.schedule.find((m) => m.id === el.dataset.id);
    ctx.update((S) => markPlayed(S, el.dataset.id, played, ctx.now()), {
      toast: match ? `${shortLabel(match)} marked ${played ? "played" : "not played"}` : "",
    });
  },
};
