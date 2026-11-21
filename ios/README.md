# Obelisk for iOS

Native SwiftUI app for Obelisk. Same server, same data, same design language as the web app,
with a ChatGPT-style shell and Liquid Glass chrome (iOS 26+).

- Xcode 27, iOS 26.0+, iPhone. Swift 5 language mode.
- No third-party dependencies.
- Targets: `Obelisk` (app), `ObeliskWidget` (WidgetKit), `ObeliskShare` (share extension).
  All three compile `Shared/`. Folders are file-system synchronized: a new `.swift` file in a target's
  folder is part of that target, no project edits needed.

## Run it

```bash
open ios/Obelisk.xcodeproj
```

Pick the `Obelisk` scheme and an iPhone simulator. The login screen asks for the server
(default `https://obelisk.lxvu.dev`; tap the server line to change it).

Against a local backend (`bun run dev` serves the API on :4000; a worktree may use another port),
DEBUG builds read these environment variables, set in the scheme or through `simctl`:

```bash
SIMCTL_CHILD_OBELISK_SERVER=http://localhost:4000 \
SIMCTL_CHILD_OBELISK_DEV_EMAIL=demo@obelisk.test SIMCTL_CHILD_OBELISK_DEV_PASSWORD=obelisk-demo-1234 \
xcrun simctl launch booted dev.lxvu.obelisk -route today -push task:#4 -theme dark
```

- `-route` opens a sidebar page: `home overview inbox today upcoming mine all forecast logbook trash project:<id>`
- `-push` pushes a screen: `task:<id|#number>`, `settings:<general|org|ai|jev|webhooks>`
- `-theme light|dark`
- `-workspace <id>` opens that workspace

### On your iPhone

1. The server must accept the iOS client: deploy the backend with `x-obelisk-client: ios` allowed
   (`backend/src/auth/auth.guard.ts`). Until then reads work and every write is refused (403).
2. On the iPhone: Settings › Privacy & Security › Developer Mode on (asks to restart).
3. Connect it with a cable (or the same Wi-Fi after the first pairing), unlock it, trust the Mac.
4. In Xcode, Signing & Capabilities: pick your team for `Obelisk`, `ObeliskWidget` and
   `ObeliskShare` (App Group `group.dev.lxvu.obelisk` stays enabled on each).
5. Choose the iPhone as the run destination and press Run (⌘R). The first time, approve the
   developer certificate on the phone: Settings › General › VPN & Device Management.
6. Sign in with your Obelisk account; the server line on the login screen should read
   `obelisk.lxvu.dev`.

With a free Apple account the app stops opening after 7 days; run it from Xcode again to renew.
A paid developer account lasts a year and can use TestFlight.

## Layout

```
ios/
  Obelisk/                 app target
    App/                   entry point, deep links (obelisk://…)
    Shell/                 ChatGPT-style shell: sidebar, top bar, workspace switcher, login
    Store/                 AppStore (port of web/src/lib/store.ts), Router, Toasts, inputs, reschedule flow
    Components/            shared views: TaskRow, ImpactView, pickers, UI kit
    Screens/<Area>/        one folder per screen area
    System/                notifications, background refresh, App Intents (Siri / Shortcuts)
  Shared/                  compiled into the app and both extensions
    Models/                port of packages/core/src/types.ts (Foundation only)
    Core/                  port of the rest of packages/core + web/src/lib pure helpers (Foundation only)
    Session/               API client, Keychain session, App Group snapshot
    Theme/                 design tokens (port of web/src/app/globals.css)
  ObeliskWidget/           widgets (read the App Group snapshot)
  ObeliskShare/            share extension (creates a task through the API)
  CoreTests/               tests for Shared/Models + Shared/Core, run with plain swiftc
  Config/                  Info.plists, entitlements
```

`CoreTests/run.sh` compiles `Shared/Models` and `Shared/Core` with the tests on macOS and runs them.

## How the app talks to the server

Exactly like the web: `POST /api/auth/login` sets the `obelisk_session` cookie. The app keeps that
token in the Keychain (access group = the App Group, so the extensions can use it) and sends it back
as a `Cookie` header with `x-obelisk-client: ios` (the backend accepts `web` and `ios` for
cookie-authenticated writes). Because it is a session, every web feature works, including
session-only actions such as sharing projects and creating API tokens.

`AppStore` loads one workspace with `GET /api/bootstrap`, applies writes optimistically and rolls
back on failure, and refreshes every 20 seconds while the app is in front. After each change it
writes `snapshot.json` to the App Group container (widget, Siri, share extension) and reschedules
local notifications.

## Picking several tasks, undo and keyboard shortcuts

- **선택 모드** on every task list (오늘, 인박스, 전체, 예정 and 프로젝트 in list mode, 내 작업, 완료 기록,
  휴지통): the top bar's 선택 button, a row menu's 선택, or a two-finger pan down the rows. The list
  is a `List(selection:)` in edit mode (`Components/SelectableList.swift`); `Router.selection`
  (`Store/TaskSelection.swift`) holds the picks so the top bar (N개 선택, 모두 선택) and the bottom bar
  that replaces the composer (완료 · 미루기 · 프로젝트 · 우선순위 · 삭제; 휴지통: 되살리기 · 영구 삭제)
  read the same thing. Ten or more tasks ask before going to the trash.
- **One undo history** (`Store/UndoCenter.swift`): every change pushes an entry once the server
  accepts it; the toast's 실행 취소, a shake and ⌘Z / ⌘⇧Z walk the same list.
- **Hardware keyboard** (`Shell/ShellKeys.swift`; iPhone with a keyboard, iPad compatibility mode):
  ⌘N 새 작업 · ⌘K / ⌘F 검색 · ⌘Z / ⌘⇧Z · ⌘A 모두 선택 · ⌫ / ⌘⌫ 휴지통 · ⌘↵ 완료 · ⌘D 복제 · ⌘C 텍스트로
  복사 · ⌘V 줄마다 작업 만들기 · Esc 선택 끝내기. They act on the picks, else on the open task.
- **Tasks as text** (`Shared/Core/TaskText.swift`, same as web `task-text.ts`): a copied task is a
  quick-add line (`견적서 보내기 11/22 15:00 #런칭 !높음`); pasted lines become tasks, and pasting
  several lines into the composer offers 줄마다 작업 N개 만들기.

## Outside the app

- **Notifications** (`Obelisk/System/Reminders.swift`, 설정 › 알림): a reminder before each start and
  due time (default 10 minutes; the web's webhook options), with 완료 and 10분 뒤 다시 알림 actions, and
  a morning summary of what's due and overdue. Built from `GET /api/overview`, so tasks in every
  space count, with the open workspace's live edits on top. Rebuilt from scratch on every change.
  The SDK's async `UNUserNotificationCenter` calls hung when awaited from the main actor here, so
  callback wrappers are used instead (bottom of Reminders.swift).
- **Background refresh** (`AppDelegate`): every ~30 minutes iOS lets the app reload the snapshot,
  reschedule reminders and reload widgets.
- **Widgets** (`ObeliskWidget/`): 오늘 (small/medium/large, lock screen) with checkboxes that complete
  tasks in place, and 지연 위험 (forecast summary). They read the snapshot; taps open
  `obelisk://task/<id>` or the page.
- **Siri and Shortcuts** (`Shared/Intents/`, `Obelisk/System/AppShortcuts.swift`): "Obelisk에 할 일
  추가" (parses "내일 오후 3시 #블로그 !높음" like the composer), "Obelisk 오늘 할 일", "Obelisk에서 …
  완료". No setup needed.
- **Share sheet** (`ObeliskShare/`): text or a link from any app becomes a task (first line → title,
  the rest and the link → notes), parsed like the composer, with a project picker.

## Design rules

The web's house rules (top of `web/src/app/globals.css`) apply unchanged to content:

- Pure bases: `#ffffff` light, `#000000` dark, everywhere content lives. Separate surfaces with
  hairlines (`Ob.border`) and faint alpha fills (`Ob.surface2`, `Ob.tint`), never grey backgrounds.
- Neutral ink. Colour only for meaning: danger = overdue/conflict, warn = slipping, ok = done,
  info = in progress, project hue = identity. Primary is monochrome.
- No gradients, glows, neon or violet "AI" accents; no sparkle icons (Jev uses `scalemass`,
  AI connections use `powerplug`). No coloured stripes on card edges, no pill + dot chips,
  no icon tiles above headings, no ALL-CAPS labels.
- Resting cards get a hairline, never a shadow.
- Motion explains a change and stops: `ObMotion.*` timing curves only. No springs, bounces,
  count-ups, sheens or loops (a spinner while loading is the one loop).
- Copy is plain and specific Korean. No exclamation marks, no emoji, no em-dashes.
- Pills for buttons (`.buttonStyle(.obPrimary/.obOutline/.obGhost)`); radius 10 rows, 16 cards,
  20 sheets.

iOS additions:

- **Liquid Glass is for chrome that floats**: the navigation bar's buttons, the composer, toasts,
  menus, sheets at partial height. Never on cards, rows or page backgrounds.
- Use system controls where iOS has one (Menu, Picker, DatePicker, Toggle, swipe actions,
  context menus, sheets with detents) and style them with the tokens.
- Type follows Dynamic Type through `ObFont` (the web's 14px base maps to iOS body 17pt).
- 44pt minimum touch targets; VoiceOver labels in Korean on icon-only buttons.
