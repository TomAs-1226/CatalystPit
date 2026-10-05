// The one door to the Rust side.
//
// Inside the desktop app every command goes to Tauri. In a plain browser (`npm run serve`) there is
// no Tauri, so the commands are answered here from memory: enough to lay out and click through the
// interface, with nothing saved and the status bar saying so. The screenshot harness does not use
// this fallback; it injects its own `window.__TAURI__` ahead of this module.

const tauri = window.__TAURI__;

/** Whether this is the real app, or the harness standing in for it. */
export const native = Boolean(tauri?.core?.invoke);

const preview = {
  data: null,
  settings: { team: 5805, eventKey: "", hasNexusKey: false, robotLink: false, lowRestVolts: 12.5, weakMilliohm: 20 },
};

const PREVIEW = {
  app_info: () => ({ version: "preview", dataDir: "(browser preview: nothing is saved)" }),
  load_state: () => ({ data: preview.data, notice: null, damaged: false }),
  save_state: ({ data }) => { preview.data = data; },
  archive_event: () => "(not archived in the browser preview)",
  get_settings: () => ({ ...preview.settings }),
  set_settings: ({ patch }) => {
    const { nexusKey, ...rest } = patch;
    Object.assign(preview.settings, rest);
    if (nexusKey !== undefined) preview.settings.hasNexusKey = nexusKey !== "";
    return { ...preview.settings };
  },
  nexus_fetch: () => { throw "Nexus is only reached from the desktop app."; },
  export_report: () => { throw "The report is saved from the desktop app."; },
  robot_battery: () => ({ enabled: false, connected: false, address: "", volts: null, topic: null }),
};

/** Call a backend command. Rejects with a sentence that can be shown as it is. */
export async function call(command, args = {}) {
  if (native) {
    try {
      return await tauri.core.invoke(command, args);
    } catch (error) {
      throw typeof error === "string" ? error : error?.message || "Something went wrong.";
    }
  }
  const handler = PREVIEW[command];
  if (!handler) throw `No such command: ${command}`;
  return handler(args);
}
