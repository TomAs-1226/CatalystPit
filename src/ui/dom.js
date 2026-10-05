// The small pieces every view is built from. Views return HTML as strings; anything that came from
// a person or from Nexus goes through `esc` on the way in, with no exceptions.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** Line icons on a 24 grid, drawn here so nothing is fetched and nothing is a font. */
const ICONS = {
  now: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
  checklist: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.4 12.3 2.4 2.4 4.8-5.2"/>',
  battery: '<rect x="3" y="7.5" width="15.5" height="9" rx="2.4"/><path d="M21 10.6v2.8M6.6 10.4v3.2M9.8 10.4v3.2"/>',
  queue: '<path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20"/><circle cx="4.6" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="17.5" r="1" fill="currentColor" stroke="none"/>',
  log: '<path d="M6.5 3.5h8.2L19 7.8v11.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M14.5 3.8V8H19M8.5 12.5h7M8.5 16h5"/>',
  settings: '<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4"/><path d="M19.6 4.6v4.2h-4.2"/>',
  up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  edit: '<path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9z"/><path d="m13.6 6.8 3.6 3.6"/>',
  trash: '<path d="M5 7h14M9.5 7V4.8h5V7M7 7l.8 12.2h8.4L17 7"/>',
  export: '<path d="M12 4v10.5M7.8 8.2 12 4l4.2 4.2M5 14.5V19h14v-4.5"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
};

export const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/** `data-*` attributes from an object, escaped. Null and undefined are left out. */
export function data(attrs = {}) {
  return Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join("");
}

/** A button that runs an action. `act` names a handler; `d` is its data. */
export function btn(label, act, { cls = "", d = {}, ico = null, disabled = false, title = "" } = {}) {
  return `<button type="button" class="btn ${cls}" data-act="${esc(act)}"${data(d)}${disabled ? " disabled" : ""}${title ? ` title="${esc(title)}" aria-label="${esc(title)}"` : ""}>${ico ? icon(ico) : ""}${label ? `<span>${esc(label)}</span>` : ""}</button>`;
}

export const tag = (text, level = "") => `<span class="tag"${level ? ` data-level="${level}"` : ""}>${esc(text)}</span>`;

export const sideTag = (alliance) =>
  alliance ? `<span class="tag" data-side="${alliance}">${alliance === "red" ? "Red" : "Blue"}</span>` : "";

/**
 * A meter. `key` identifies it across re-renders, so its fill can travel from where it was to
 * where it now is instead of appearing there (see `settleMeters` in app.js).
 */
export function meter(key, done, total, { big = false } = {}) {
  const pct = total > 0 ? Math.round((done / total) * 1000) / 10 : 0;
  return `<div class="meter${big ? " big" : ""}" data-full="${total > 0 && done >= total}" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><div class="meter-fill" data-meter="${esc(key)}" data-to="${pct}"></div></div>`;
}

/** Team numbers in a row, or a dash when none are known. */
export const teams = (list) => (list.length ? list.map(esc).join(" · ") : "—");

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
