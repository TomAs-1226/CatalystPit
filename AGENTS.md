# AGENTS.md: Catalyst Pit

Instructions for AI coding agents working in this repo: Claude Code, and whatever model runs
when Claude isn't available. For humans, `README.md` is the guide.

## What this is

The match-day pit companion for FrcCatalyst drive teams, built on Tauri 2: a pre-match checklist,
a battery board, the team's match queue, and a match log with issues that carry forward. It runs on
the driver station laptop, usually with no network.

- **Frontend:** plain HTML/CSS/JS in `src/`, with no framework or bundler.
  - `src/core/` is the logic: pure modules that never touch the DOM, each with a `.test.js` beside it.
  - `src/ui/` draws it; `src/app.js` is the shell (state, save, clock, route).
- **Rust backend** in `src-tauri/`: atomic storage, settings, the Nexus request, and a read-only
  NetworkTables client for the robot's battery voltage.

## The three rules

Every change must keep all three.

1. **It works with no network.** Everything is a local file. Nexus fills in the schedule when it can
   be reached and is never waited on; a hand-entered schedule behaves identically.
2. **It shows only what is known.** A time was typed in or sent by Nexus. A voltage was measured by
   a person or published by the robot. Nothing is derived to fill a gap, and no demo data ships: a
   new install is empty, with empty states. The invented data in `scripts/fixtures.mjs` is for
   screenshots and never reaches the app.
3. **It never writes to the robot, and never loses notes.** `nt.rs` has no publish path and a test
   that fails if one appears. Saves are atomic with a backup; a data file this build cannot read is
   left untouched.

## Commands

- `npm install`, then `npm run vendor` (copies the Figtree font into `src/vendor/`; the CSP forbids CDNs).
- `npm test` runs the identity check, `node --test` over `src/` and `scripts/`, then `cargo test`.
  `npm run test:js` and `npm run test:rust` run the halves.
- `npm run harness` serves the real `src/` with a stand-in backend on :5210 for UI work;
  `?fixture=empty|manual|robot|nexus|offline|newer` picks the starting state.
- `npm run screenshots` drives headless Edge over the harness into `docs/screenshots/`.
- `npm run dev` runs the app; `npm run build` builds the NSIS installer into
  `src-tauri/target/release/bundle/nsis/`.
- Scripts that need cargo go through `scripts/cargo.mjs`, which adds `~/.cargo/bin` to the PATH.

## Invariants

- **The contract with the installer and the launcher.** Product name `Catalyst Pit`, identifier
  `com.frccatalyst.pit`, binary `catalyst-pit.exe`, NSIS per-user, single instance.
  `scripts/contracts.test.mjs` fails if any of these moves.
- **The identity.** `src/styles/identity.css` and `src/motion.js` are copies of FrcCatalyst's
  `docs/assets/` originals. Never edit them here; `npm test` fails when they drift. `styles.css`
  re-points the tokens to the same values Catalyst Console uses.
- **The look.** Monochrome and calm. Nothing pulses or blinks, no "live" badges, no bar of buttons
  pinned over content, no browser scrollbars, no decoration that is not information. One primary
  (blue) button per screen. Check a UI change by screenshot at both sizes.
- **The data shape** lives in `src/core/store.js` (currently schema 1). A change an older build
  would misread bumps `SCHEMA` and adds a step to `STEPS`, with a test.
- **The Nexus key** never reaches the webview or the event file. `PublicSettings` carries only
  `hasNexusKey`.
- **Version.** `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` move together.

## Git and files

- Don't commit, push, tag or release unless the user asks for it in the current session.
- There is no remote yet.
- `src/vendor/`, `src-tauri/target/` and `src-tauri/gen/` are generated and gitignored.
- Files are UTF-8 without a BOM, LF line endings. In Windows PowerShell 5.1, don't round-trip them
  through `Get-Content` / `Set-Content`. Use an editor tool.

## If you are a fallback model

Fine to take on: docs and README edits, wording in the UI, checklist defaults.

Stop and leave notes for Claude on: anything in `src-tauri/`, `src/core/store.js`, the Nexus path,
or the three rules.
