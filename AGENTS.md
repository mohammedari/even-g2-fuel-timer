# AGENTS.md

## Project overview

This repository contains Even G2 Fuel Timer, an Even Realities G2 countdown
application built with Vite, TypeScript, and the Even Hub SDK. It helps users
keep a drink-ordering pace at social gatherings. The application runs in the
Even mobile app; the glasses act as the display and input device.

## Important files

- `src/main.ts`: timer state, Canvas image generation, glasses UI, input
  handling, persistence, and application lifecycle.
- `doc/2026-09-16-design.md`: product behavior, screen layout, state machine,
  rendering pipeline, and verification plan.
- `CHANGELOG.md`: released versions and user-visible changes.
- `app.json`: Even Hub package metadata, permissions, and minimum versions.
- `index.html`: mobile WebView host page.
- `vite.config.ts`: local development server configuration.
- `package.json`: development, build, simulation, and packaging commands.

## Development commands

Use npm unless the user explicitly requests another package manager.

```powershell
npm install
npm run dev
npm run simulate
npm run build
npm run pack
```

Run `npm run dev` and `npm run simulate` in separate terminals. For a real G2,
keep the development server running and generate a QR code with:

```powershell
npx evenhub qr --url http://<LAN-IP>:5173
```

## Required verification

After changing TypeScript, configuration, dependencies, or the manifest:

1. Run `npm run build`.
2. Test the affected interaction in the Even Hub simulator when practical.
3. For gesture, lifecycle, microphone, or device-specific behavior, clearly
   state when physical-device testing is still required.
4. Run `npm run pack` when changing packaging or release configuration.

Do not commit generated `node_modules/`, `dist/`, or `*.ehpk` files.

## Fuel Timer behavior

- The timer modes are `idle`, `running`, `paused`, and `completed`; keep timer
  state separate from rendering and SDK calls.
- A single tap starts, pauses, or resumes. A double tap always calls
  `shutDownPageContainer(1)` to show the standard Even Hub exit confirmation;
  never substitute immediate exit mode `0`.
- In `idle`, scroll changes and persists the configured duration from 1 to 60
  minutes. In `paused`, scroll changes only the current remaining time. In
  `running`, scroll reveals the main screen without changing time.
- Display remaining time as whole minutes rounded up. Use an absolute deadline
  for completion so backgrounding and delayed callbacks do not introduce
  countdown drift.
- Starting or resuming must immediately clear the help text and enter compact
  mode. A running scroll may reveal the main view for five seconds.
- Keep the main mug static and full. Animate only the compact mug, alternating
  between two fill levels every 500 ms.
- Persist only the idle configured duration under the versioned localStorage
  key `even-g2-fuel-timer.settings.v1`. Invalid data falls back to 30 minutes.
- Completion shows a static empty mug and `Fuel up!` for approximately three
  seconds, then returns to `idle` with the persisted configured duration. Do
  not vertically animate the completion mug; the container clips its top edge.

## Even G2 constraints

- The glasses display is 576 x 288 pixels per eye with 16 monochrome-green
  levels. Keep layouts simple, high contrast, and readable at a glance.
- Prefer SDK container updates such as `textContainerUpgrade` over rebuilding
  the whole page, because rebuilding can visibly flicker.
- Call `createStartUpPageContainer` only once for the initial page.
- Keep all image transfers on one promise queue. Never call
  `updateImageRawData` concurrently. The two-state compact animation runs at
  two frames per second; verify that cadence and transfer load on hardware.
- Quantize composed Canvas frames to 16 grayscale levels before PNG encoding.
  Retry `sendFailed` once, but surface persistent SDK image result codes on the
  glasses instead of hiding them behind a generic error.
- Exactly one container on an interactive page must capture events with
  `isEventCapture: 1`.
- A single click has enum value `0`. Protobuf can omit this zero-valued
  `eventType`, so resolve the default only after confirming that the relevant
  event envelope exists. Preserve the `eventTypeOf` pattern in `src/main.ts`.
- Handle explicit events such as double-click and scrolling before treating a
  missing event type as a single click.
- System gestures normally arrive through `sysEvent`; scrolling normally
  arrives through `textEvent`. Do not flatten unrelated envelopes into clicks.
- Deduplicate identical scroll directions received within 250 ms because real
  hardware can report one physical swipe through multiple event envelopes.
- When an idle or paused scroll changes only the displayed minutes, update the
  timer image alone; do not retransmit the mug, compact image, or help text.
- Keep double-click as the reliable exit path and preserve its use of
  `shutDownPageContainer(1)`.
- Unsubscribe listeners when the app receives a normal or abnormal exit event.
- Clear countdown, compact-view, animation, and completion timers on exit.
- The glasses have no speaker or camera. Phone capabilities may require SDK
  permissions and explicit user consent.

## Manifest rules

- Keep `package_id` lowercase and in reverse-domain form. Do not use hyphens.
- Keep `version` in `x.y.z` format.
- Update `app.json` permissions only when a feature needs them, and describe
  why each permission is required.
- Network access requires the appropriate manifest permission and whitelist;
  normal browser CORS rules still apply.
- Before release, replace the placeholder `com.example.evenhubminimal` package
  ID and the starter application name.

## Code conventions

- Use TypeScript with strict typing; avoid `any` unless an SDK boundary makes
  it unavoidable and document the reason.
- Keep SDK-specific work behind small, named functions instead of spreading
  bridge calls throughout unrelated logic.
- Use `async`/`await` and handle rejected SDK or network operations visibly.
- Keep application state separate from rendering so screens can be updated
  without losing state.
- Keep Canvas output high-contrast and friendly to the glasses' 16 luminance
  levels. Preserve the generated pictogram's alpha channel, bold silhouette,
  and separated gray values, and cache reusable mug frames and minute images.
- Render the `Fuel up!` lockup from `src/assets/fuel-up-logotype.png`; do not
  replace it with device-font text unless a redesign is explicitly requested.
- Prefer small focused changes and preserve existing behavior unless the user
  requests a redesign.
- Do not add dependencies when the platform or existing code can solve the
  problem clearly.

## Secrets and network services

- Never commit API keys, tokens, or credentials.
- Put local secrets in `.env.local` and document required variables in
  `.env.example` using non-secret placeholders.
- Do not expose secret API keys directly in the client bundle. Use a backend
  relay for services that cannot safely be called from a browser.

## Scope and safety

- Preserve user-authored changes and unrelated repository files.
- Do not change the package ID, permissions, deployment target, or external
  services without explaining the impact.
- Do not publish, submit, or upload an `.ehpk` unless the user explicitly asks.
