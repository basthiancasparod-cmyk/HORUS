# HORUS — Browser tests (Playwright + TypeScript)

End-to-end tests for the real app in a real browser. They complement the
Node suites in `tests/` (core logic, views on a fake DOM): these drive the
actual UI — onboarding, auth validation, roster, calendar, hours, export.

## Run

```bash
npm run test:e2e        # full suite (starts the dev server on :5173)
npx playwright test tests-e2e/h03-roster.spec.ts   # one file
```

## Coverage

| ID | Flow |
|----|------|
| H-01 | First run: auth screen -> "Usar sin cuenta" -> setup wizard -> app opens with the team and the default shift catalogue |
| H-02 | Sign-in with an invalid email shows a validation error |
| H-03 | Sign-in with a short password shows a validation error |
| H-04 | Assign a morning shift in the roster (cell shows `M`, entry stored) |
| H-05 | Assign a night shift, then Undo removes it |
| H-06 | Clearing a shift with "Sin turno" removes the entry |
| H-07 | Calendar month shows the assigned shift as a bar on its day |
| H-08 | Calendar month navigation moves forward and back |
| H-09 | Hours view totals an assigned morning shift (8h 30m) |
| H-10 | Export dialog CSV preview contains the assigned shift |

## How the tests run (and what they deliberately do not do)

- **Local mode only.** Every test uses "Usar sin cuenta" and the setup
  wizard. No account is created, no data is written to Supabase, and all
  Supabase traffic is blocked at the browser level. The stored document in
  `localStorage` (`horus.doc.v4`) is the assertion source of truth.
- **Phone-width viewport (390×844).** HORUS is a mobile-first PWA: on a
  narrow screen Calendar / Shifts / Hours live under the "Más" menu, and
  the suite navigates through it (`goToView` in `helpers.ts`). The
  secondary nav buttons are `display: none` at desktop width, so clicking
  them directly would never work.
  reloads the page once when it first takes control. The suite stubs
  `navigator.serviceWorker` before load so that reload cannot interrupt a
  test mid-flow. Offline/PWA behaviour is therefore out of scope here.
- **Fonts blocked.** Google Fonts are aborted so a slow or unreachable
  network cannot stall page load; the app itself is served from localhost.
- **No secrets.** The only data used is the fictional team created by the
  tests themselves (Ana Ruiz, Luis Peña, Marta Gil). Nothing in this
  folder references a real account, key, or the app's default cloud
  project.

## What still needs a real account (not covered here)

Team sync, sign-in/sign-up against Supabase, the team invite-code flow,
and PDF/CSV import of a real company roster all need a test account and
a test Supabase project. They are intentionally not covered: this suite
must stay runnable on any machine with `npm install` and nothing else.
To cover them, run the suite from a machine with normal internet, create
a dedicated Supabase test account, and delete its data after.
