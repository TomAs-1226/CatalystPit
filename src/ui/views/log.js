// The match log: one match at a time on the left, everything recorded about it on the right, and
// the event's issues underneath, since they are what carries from one match into the next.

import { esc, btn, tag, sideTag, teams, plural } from "../dom.js";
import { clock, day, stamp, volts, sameDay } from "../../core/format.js";
import { sorted, nextMatch, isPlayed, sides, shortLabel, longLabel, byId } from "../../core/queue.js";
import {
  SEVERITIES, SEVERITY_NAMES, summary, hasLog, setNotes, setBattery, addIssue, editIssue, fixIssue, reopenIssue,
  removeIssue, openIssues, fixedIssues,
} from "../../core/matchlog.js";
import { runSummary, progress } from "../../core/checklist.js";
import { buildReport, reportFileName } from "../../core/report.js";
import { openSheet, confirmSheet } from "../sheet.js";
import { call } from "../../bridge.js";

/** The match the screen is showing: the one chosen, else the last one played, else the next. */
function selectedId(ctx) {
  const { S, ui } = ctx;
  if (ui.logMatch && byId(S, ui.logMatch)) return ui.logMatch;
  const now = ctx.now();
  const all = sorted(S);
  const played = all.filter((m) => isPlayed(m, now));
  return (played.at(-1) ?? nextMatch(S, now) ?? all[0])?.id ?? null;
}

function listHtml(ctx, selected) {
  const now = ctx.now();
  return sorted(ctx.S).map((m) => {
    const state = isPlayed(m, now) ? (hasLog(ctx.S, m) ? "logged" : "played") : "";
    return `<button type="button" class="mrow" data-act="log-pick" data-id="${esc(m.id)}" aria-current="${m.id === selected}"><b>${esc(shortLabel(m))}</b><span>${state}</span></button>`;
  }).join("");
}

function fact(key, value, none = false) {
  return `<div class="fact"><div class="fact-k">${esc(key)}</div><div class="fact-v${none ? " none" : ""}">${value}</div></div>`;
}

function issueRow(ctx, issue, { showMatch = true } = {}) {
  const match = issue.matchId ? byId(ctx.S, issue.matchId) : null;
  const now = ctx.now();
  const when = (t) => (t === null ? "" : sameDay(t, now) ? clock(t) : stamp(t));
  const meta = [];
  if (showMatch && match) meta.push(`After ${shortLabel(match)}`);
  if (issue.openedAt !== null) meta.push(`raised ${when(issue.openedAt)}`);
  if (issue.state === "fixed" && issue.fixedAt !== null) meta.push(`fixed ${when(issue.fixedAt)}${issue.fixNote ? `: ${issue.fixNote}` : ""}`);
  const d = { id: issue.id };
  const buttons = issue.state === "open"
    ? btn("Fixed", "issue-fix", { cls: "small", d }) + btn("", "issue-edit", { cls: "icon ghost", ico: "edit", d, title: "Edit issue" })
    : btn("Reopen", "issue-reopen", { cls: "small ghost", d });
  return `<div class="issue" data-state="${issue.state}">
    <div>
      <div class="issue-top"><span class="sev" data-sev="${issue.state === "fixed" ? "fixed" : issue.severity}">${issue.state === "fixed" ? "Fixed" : esc(SEVERITY_NAMES[issue.severity])}</span><span class="issue-title">${esc(issue.title)}</span></div>
      ${issue.detail ? `<div class="issue-detail">${esc(issue.detail)}</div>` : ""}
      ${meta.length ? `<div class="issue-meta">${esc(meta.join(" · "))}</div>` : ""}
    </div>
    <div class="row-actions">${buttons}</div>
  </div>`;
}

function detailHtml(ctx, match) {
  const now = ctx.now();
  const { S, settings } = ctx;
  const s = summary(S, match);
  const side = sides(match, settings.team);
  const played = isPlayed(match, now);
  const isNext = nextMatch(S, now)?.id === match.id;
  const d = { id: match.id };

  const when = match.times.start !== null ? `${sameDay(match.times.start, now) ? "" : `${day(match.times.start)} `}${clock(match.times.start)}` : null;
  const facts = [
    fact("Start", when ? esc(when) : "Not entered", !when),
    fact("With", side.partners.length ? teams(side.partners) : "Not entered", !side.partners.length),
    fact("Against", side.opponents.length ? teams(side.opponents) : "Not entered", !side.opponents.length),
  ].join("");

  const batteryOptions = [`<option value=""${s.battery ? "" : " selected"}>Not logged</option>`]
    .concat(S.batteries.map((b) => `<option value="${esc(b.id)}"${s.battery?.id === b.id ? " selected" : ""}>${esc(b.label)}</option>`))
    .join("");
  const reading = (r) => (r?.volts != null ? volts(r.volts) : "Not measured");
  const battery = S.batteries.length
    ? `<div class="pair batt-pair">
        <div class="fact" style="padding:8px 8px 8px 16px;display:flex;align-items:center;gap:12px"><span class="fact-k" style="flex:none">Battery</span><select data-change="log-battery" data-id="${esc(match.id)}" aria-label="Battery used" style="background-color:transparent;min-height:44px">${batteryOptions}</select></div>
        ${fact("Went in at", esc(reading(s.voltsIn)), s.voltsIn?.volts == null)}
        ${fact("Came out at", esc(reading(s.voltsOut)), s.voltsOut?.volts == null)}
      </div>`
    : `<p class="quiet">No batteries on the board. Add them on the battery screen and the one used will be recorded here when it goes in.</p>`;

  const draft = progress(S.checklist, match.id);
  let checklist;
  if (s.run) {
    const missed = s.run.missed.length ? `<ul style="margin:8px 0 0;padding-left:18px" class="quiet">${s.run.missed.map((m) => `<li>${esc(m.text)}</li>`).join("")}</ul>` : "";
    checklist = `<div class="row" style="padding:0"><div class="row-main"><div class="row-title">${esc(runSummary(s.run))}</div><div class="row-sub">Stamped ${clock(s.run.at)}</div>${missed}</div>${s.run.missed.length ? tag(`${s.run.missed.length} skipped`, "warn") : tag("Complete", "ok")}</div>`;
  } else {
    checklist = `<div class="row" style="padding:0"><div class="row-main"><div class="row-title dim">${draft.started ? `${draft.done} of ${draft.total} ticked, not stamped` : "Not run for this match"}</div></div>${btn("Open checklist", "log-checklist", { cls: "small", d })}</div>`;
  }

  const issues = s.issues.length
    ? s.issues.map((i) => issueRow(ctx, i, { showMatch: false })).join("")
    : `<p class="quiet">Nothing raised after this match.</p>`;

  return `<section class="tile detail">
    <div class="detail-head">
      <h2>${esc(longLabel(match))}</h2>
      ${sideTag(side.alliance)}
      ${played ? tag("Played") : isNext ? tag("Next", "signal") : ""}
    </div>
    <div class="pair">${facts}</div>

    <div class="sect"><div class="sect-head"><h3>Battery</h3></div>${battery}</div>
    <div class="sect"><div class="sect-head"><h3>Checklist</h3></div>${checklist}</div>
    <div class="sect"><div class="sect-head"><h3>Notes</h3></div>
      <textarea data-change="log-notes" data-id="${esc(match.id)}" aria-label="Notes for ${esc(longLabel(match))}" placeholder="What happened, what the drivers said, what to change.">${esc(s.notes)}</textarea>
    </div>
    <div class="sect"><div class="sect-head"><h3>Issues raised after this match</h3>${btn("Raise an issue", "issue-add", { cls: "small", ico: "plus", d: { match: match.id } })}</div>${issues}</div>

    <div class="head-actions" style="padding-top:4px">
      ${btn(played ? "Mark not played" : "Mark played", "match-played", { cls: played ? "ghost" : "", d: { id: match.id, played: String(!played) } })}
      ${match.source === "manual" ? btn("Correct times", "match-edit", { cls: "ghost", d }) : ""}
      ${btn("Remove", "match-remove", { cls: "ghost danger", d })}
    </div>
  </section>`;
}

function issuesTile(ctx) {
  const open = openIssues(ctx.S);
  const fixed = fixedIssues(ctx.S);
  const openHtml = open.length
    ? open.map((i) => issueRow(ctx, i)).join("")
    : `<p class="quiet" style="padding:6px 0 10px">Nothing is open. An issue raised here stays on the checklist screen until it is marked fixed.</p>`;
  const fixedHtml = fixed.length
    ? `<details class="run" style="margin-top:6px"><summary><span class="row-main"><span class="row-title dim">${plural(fixed.length, "fixed issue")}</span></span></summary>${fixed.map((i) => issueRow(ctx, i)).join("")}</details>`
    : "";
  return `<section class="tile" id="issues">
    <div class="tile-label"><span>Issues · ${open.length} open</span>${btn("Raise an issue", "issue-add", { cls: "small", ico: "plus" })}</div>
    ${openHtml}${fixedHtml}
  </section>`;
}

export function render(ctx) {
  const { S } = ctx;
  const head = `<div class="head"><h1>Match log</h1><div class="head-actions">${btn("Export report", "report-export", { ico: "export" })}</div></div>`;
  const id = selectedId(ctx);
  const match = id ? byId(S, id) : null;

  const top = match
    ? `<div class="log-grid"><nav class="tile matchlist" aria-label="Matches">${listHtml(ctx, id)}</nav>${detailHtml(ctx, match)}</div>`
    : `<section class="tile empty-tile"><div class="empty">
        <h2>No matches to log yet</h2>
        <p>Once the schedule has matches, each one gets a page here: the battery it used, the checklist result, your notes, and any issues it turned up.</p>
        <div class="tile-actions">${btn("Add a match", "match-add", { cls: "primary", ico: "plus" })}</div>
      </div></section>`;
  return `${head}${top}${issuesTile(ctx)}`;
}

// ---- issue sheets ------------------------------------------------------------------------------

const severityField = (value) => ({
  name: "severity", label: "How bad", type: "seg", value,
  options: SEVERITIES.map((s) => ({ value: s, label: SEVERITY_NAMES[s] })),
});

function issueSheet(ctx, { id = null, matchId = null } = {}) {
  const existing = id ? ctx.S.issues.find((i) => i.id === id) : null;
  const now = ctx.now();
  // An issue raised from the issue list, with no match in hand, most likely came from the last one played.
  const lastPlayed = sorted(ctx.S).filter((m) => isPlayed(m, now)).at(-1)?.id ?? "";
  const matches = [{ value: "", label: "No particular match" }, ...sorted(ctx.S).map((m) => ({ value: m.id, label: longLabel(m) }))];

  openSheet({
    title: existing ? "Edit issue" : "Raise an issue",
    fields: [
      { name: "title", label: "What is wrong", value: existing?.title ?? "", placeholder: "Intake belt skipping under load" },
      severityField(existing?.severity ?? "medium"),
      { name: "detail", label: "Detail (optional)", type: "textarea", value: existing?.detail ?? "", placeholder: "Where, when, what was tried" },
      ...(existing ? [] : [{ name: "matchId", label: "Noticed after", type: "select", value: matchId ?? lastPlayed, options: matches }]),
    ],
    extra: existing ? [{
      label: "Delete",
      danger: true,
      run: () => confirmSheet({
        title: "Delete this issue?",
        intro: "It is removed from the log and the report. If it was dealt with, mark it fixed instead.",
        submit: "Delete",
        danger: true,
        run: () => ctx.update((S) => removeIssue(S, existing.id)),
      }),
    }] : [],
    submit: existing ? "Save" : "Raise",
    onSubmit: (values) => {
      let error = null;
      ctx.update((S) => {
        error = (existing
          ? editIssue(S, existing.id, values)
          : addIssue(S, { ...values, matchId: values.matchId || null }, ctx.now())).error ?? null;
      }, {});
      if (error) return error;
      if (!existing) ctx.toast("Issue raised. It will show on the checklist until it is fixed.");
    },
  });
}

export const actions = {
  "log-pick": (ctx, el) => {
    ctx.ui.logMatch = el.dataset.id;
    ctx.render({ keepFocus: `[data-act="log-pick"][data-id="${CSS.escape(el.dataset.id)}"]` });
  },

  "log-notes": (ctx, el) => ctx.update((S) => setNotes(S, el.dataset.id, el.value), { render: false }),
  "log-battery": (ctx, el) => ctx.update((S) => setBattery(S, el.dataset.id, el.value)),

  "log-checklist": (ctx, el) => {
    ctx.ui.clMatch = el.dataset.id;
    ctx.go("checklist");
  },

  "issue-add": (ctx, el) => issueSheet(ctx, { matchId: el.dataset.match ?? null }),
  "issue-edit": (ctx, el) => issueSheet(ctx, { id: el.dataset.id }),
  "issue-reopen": (ctx, el) => ctx.update((S) => reopenIssue(S, el.dataset.id), { toast: "Issue reopened" }),

  "issue-fix": (ctx, el) => {
    const issue = ctx.S.issues.find((i) => i.id === el.dataset.id);
    if (!issue) return;
    openSheet({
      title: "Mark as fixed",
      intro: issue.title,
      fields: [{ name: "note", label: "What was done (optional)", value: issue.fixNote, placeholder: "Re-tensioned the belt, added a zip tie" }],
      submit: "Fixed",
      onSubmit: ({ note }) => { ctx.update((S) => fixIssue(S, issue.id, note, ctx.now()), { toast: "Marked fixed" }); },
    });
  },

  "report-export": async (ctx) => {
    const now = ctx.now();
    const markdown = buildReport(ctx.S, { team: ctx.settings.team, now, limits: ctx.limits });
    try {
      const path = await call("export_report", { markdown, fileName: reportFileName(ctx.S, ctx.settings.team, now) });
      if (path) ctx.toast(`Report saved to ${path}`);
    } catch (error) {
      ctx.toast(String(error));
    }
  },
};
