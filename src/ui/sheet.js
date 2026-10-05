// The sheet: the one floating layer, used whenever something has to be typed or confirmed.
//
// A sheet is described, not built: a title, some fields, what the main button says and what happens
// when it is pressed. `onSubmit` gets the values and returns nothing to close, or a sentence to show
// as the error and stay open. Escape, the scrim and Cancel all close it without doing anything.
//
// It is glass because it floats, per the identity; nothing else in the app is.

import { esc } from "./dom.js";

const scrim = () => document.getElementById("scrim");
const sheet = () => document.getElementById("sheet");

let current = null;

function fieldHtml(f) {
  const id = `f-${f.name}`;
  const hint = f.hint ? `<small>${esc(f.hint)}</small>` : "";
  const label = f.label ? `<label for="${id}">${esc(f.label)}</label>` : "";
  const common = `id="${id}" name="${esc(f.name)}" autocomplete="off" spellcheck="false"`;

  if (f.type === "static") return `<div class="field">${f.label ? `<span>${esc(f.label)}</span>` : ""}${f.html}</div>`;

  if (f.type === "seg") {
    const buttons = f.options
      .map((o) => `<button type="button" class="seg-btn" data-seg="${esc(f.name)}" data-value="${esc(o.value)}" aria-pressed="${String(o.value) === String(f.value ?? "")}">${esc(o.label)}</button>`)
      .join("");
    return `<div class="field"><span>${esc(f.label)}</span><div class="seg" role="group" aria-label="${esc(f.label)}">${buttons}</div><input type="hidden" name="${esc(f.name)}" value="${esc(f.value ?? "")}" />${hint}</div>`;
  }

  if (f.type === "select") {
    const options = f.options
      .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value ?? "") ? " selected" : ""}>${esc(o.label)}</option>`)
      .join("");
    return `<div class="field">${label}<select ${common}>${options}</select>${hint}</div>`;
  }

  if (f.type === "textarea") {
    return `<div class="field">${label}<textarea ${common} rows="3" placeholder="${esc(f.placeholder ?? "")}">${esc(f.value ?? "")}</textarea>${hint}</div>`;
  }

  // Numbers are typed into a text field with a numeric keypad, not `type="number"`: that one
  // swallows a comma decimal and returns an empty string, which would log a blank as a reading.
  const type = f.type === "password" ? "password" : f.type === "date" ? "date" : "text";
  const mode = f.type === "number" ? ' inputmode="decimal"' : f.inputmode ? ` inputmode="${f.inputmode}"` : "";
  return `<div class="field${f.big ? " big" : ""}">${label}<input type="${type}" ${common}${mode} value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder ?? "")}" />${hint}</div>`;
}

function rowsHtml(fields) {
  // Fields that share a `row` sit side by side.
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f.row) { out.push(fieldHtml(f)); continue; }
    const group = [f];
    while (fields[i + 1]?.row === f.row) group.push(fields[++i]);
    out.push(`<div class="field-row">${group.map(fieldHtml).join("")}</div>`);
  }
  return out.join("");
}

/**
 * Open a sheet.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} [spec.intro]       a sentence under the title
 * @param {Array}  [spec.fields]      { name, label, type, value, placeholder, hint, options, big, row }
 * @param {string} [spec.submit]      the main button's label; omit for a sheet that only closes
 * @param {boolean} [spec.danger]     the main button removes something
 * @param {Array}  [spec.extra]       further buttons: { label, danger, body, run(close) }
 * @param {Function} [spec.onSubmit]  (values) => undefined | string | Promise of either
 */
export function openSheet(spec) {
  const el = sheet();
  // Further things the sheet can do. Those marked `body` sit with the fields as a row of small
  // buttons; the rest, usually the one that deletes, sit at the left of the foot.
  const all = (spec.extra || []).map((x, i) => ({ ...x, i }));
  const inBody = all.filter((x) => x.body)
    .map((x) => `<button type="button" class="btn small" data-extra="${x.i}">${esc(x.label)}</button>`)
    .join("");
  const inFoot = all.filter((x) => !x.body);
  const extra = inFoot
    .map((x, n) => `<button type="button" class="btn ghost${x.danger ? " danger" : ""}${n === inFoot.length - 1 ? " spacer" : ""}" data-extra="${x.i}">${esc(x.label)}</button>`)
    .join("");
  el.innerHTML = `
    <div class="sheet-head">
      <h2 id="sheetTitle">${esc(spec.title)}</h2>
      ${spec.intro ? `<p>${esc(spec.intro)}</p>` : ""}
    </div>
    <div class="sheet-body">${rowsHtml(spec.fields || [])}${inBody ? `<div class="sheet-actions">${inBody}</div>` : ""}</div>
    <div class="sheet-error" id="sheetError" role="alert"></div>
    <div class="sheet-foot">
      ${extra}
      <button type="button" class="btn ghost" data-sheet="close">${spec.submit ? "Cancel" : "Close"}</button>
      ${spec.submit ? `<button type="submit" class="btn ${spec.danger ? "danger" : "primary"}">${esc(spec.submit)}</button>` : ""}
    </div>`;

  current = { spec, returnTo: document.activeElement };
  const s = scrim();
  s.classList.remove("leaving");
  s.hidden = false;

  const first = el.querySelector("input:not([type=hidden]), textarea, select") || el.querySelector("button[type=submit]") || el.querySelector("button");
  first?.focus();
  if (first?.select && first.type !== "date") first.select();
}

export function closeSheet() {
  if (!current) return;
  const { returnTo } = current;
  current = null;
  const s = scrim();
  s.classList.add("leaving");
  const done = () => {
    s.hidden = true;
    s.classList.remove("leaving");
    sheet().innerHTML = "";
  };
  // The leave is `effect`-long; if animations are off it never fires, so a timer backs it up.
  const timer = setTimeout(done, 280);
  s.addEventListener("animationend", (e) => { if (e.target === s) { clearTimeout(timer); done(); } }, { once: true });
  if (returnTo?.isConnected) returnTo.focus?.();
}

export const sheetOpen = () => current !== null;

function values() {
  const out = {};
  for (const [key, value] of new FormData(sheet()).entries()) out[key] = typeof value === "string" ? value : "";
  return out;
}

function showError(text) {
  document.getElementById("sheetError").textContent = text || "";
}

async function submit() {
  if (!current?.spec.onSubmit) return closeSheet();
  const open = current;
  let result;
  try {
    result = await open.spec.onSubmit(values());
  } catch (error) {
    result = typeof error === "string" ? error : error?.message || "That did not work.";
  }
  if (current !== open) return;            // closed, or replaced by another sheet, while waiting
  if (typeof result === "string" && result) showError(result);
  else closeSheet();
}

/** Wire the sheet's own events once, at boot. */
export function initSheet() {
  const el = sheet();
  const s = scrim();

  el.addEventListener("submit", (e) => { e.preventDefault(); submit(); });

  el.addEventListener("click", (e) => {
    const seg = e.target.closest("[data-seg]");
    if (seg) {
      const name = seg.dataset.seg;
      const input = el.querySelector(`input[type=hidden][name="${CSS.escape(name)}"]`);
      // Pressing the chosen one again clears it, where the choice is optional.
      const already = seg.getAttribute("aria-pressed") === "true";
      const optional = current?.spec.fields?.find((f) => f.name === name)?.optional;
      for (const b of el.querySelectorAll(`[data-seg="${CSS.escape(name)}"]`)) b.setAttribute("aria-pressed", "false");
      if (already && optional) input.value = "";
      else { seg.setAttribute("aria-pressed", "true"); input.value = seg.dataset.value; }
      return;
    }
    if (e.target.closest("[data-sheet=close]")) return closeSheet();
    const extra = e.target.closest("[data-extra]");
    if (extra) current?.spec.extra?.[Number(extra.dataset.extra)]?.run(closeSheet);
  });

  // The scrim closes only on a press that both began and ended on it, so dragging a text selection
  // out of a field and letting go over the scrim does not throw away what was typed.
  let downOnScrim = false;
  s.addEventListener("pointerdown", (e) => { downOnScrim = e.target === s; });
  s.addEventListener("click", (e) => { if (e.target === s && downOnScrim) closeSheet(); });

  document.addEventListener("keydown", (e) => {
    if (!current) return;
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
    if (e.key !== "Tab") return;
    // Keep Tab inside the sheet: what is behind it is not there to be used.
    const stops = [...el.querySelectorAll("input:not([type=hidden]), textarea, select, button")].filter((n) => !n.disabled);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  });
}

/** A yes-or-no question. `run` happens on yes. */
export function confirmSheet({ title, intro, submit, danger = false, run }) {
  openSheet({ title, intro, submit, danger, onSubmit: () => run() });
}
