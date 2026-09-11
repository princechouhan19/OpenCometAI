# License Flow & Deployment Guide

This document captures the new license service, how it is deployed, and how the extension now interfaces with it.

## 1. Backend service (`Open Comet Web/backend/`)

- **Stack**: Node.js + Express + Mongoose talking to MongoDB Atlas.
- **Deployment**: Host on Render (free Web Service) using `Open Comet Web/backend` as the service root with `npm start`. Point Render's `MONGO_URI` env to an Atlas M0 cluster, set `LICENSE_RELEASE_DATE` to the UTC timestamp when trials expire, configure `AD_WATCH_SECRET`, and add `OPENAI_API_KEY` for the hosted browser-agent model.
- **Endpoints**
  - `POST /api/licenses/trial` ➜ requires `{ email }`, returns `{ key, license }` with expiry clamped to the release date.
  - `POST /api/licenses/premium` ➜ requires `{ email }`, issues a 30-day paid key.
  - `GET /api/licenses/daily/challenge` ➜ returns a short-lived challenge for the ad flow.
  - `POST /api/licenses/daily` ➜ accepts `{ email, challenge, signature }` (the ad partner must HMAC `email:challenge` with `AD_WATCH_SECRET`) and issues a daily key.
  - `POST /api/licenses/validate` ➜ accepts `{ key }` and returns `{ valid, license }` for client-side gating.
  - `POST /api/agent/browser/respond` ➜ accepts browser context plus a valid license key and returns the planner/navigator JSON. This is where the high-value browser-agent prompt logic now lives.
- **Release flow**: set `LICENSE_RELEASE_DATE` to the launch+trial cutoff. Trials refuse new keys after that date and the validation endpoint treats existing trials as expired. The daily/ad flow only activates once the release date has passed.

## 2. Extension wiring

### Storage & validation
- Metadata now lives under the `opencometLicense` storage key via `src/lib/storage.js` helpers (`getLicenseInfo`, `saveLicenseInfo`).
- `src/lib/license-service.js` centralizes `fetch` helpers for the hosted website backend license API.
- `src/background/sw.js` now imports `validateLicenseKey` and runs `ensureLicense` before accepting a `START_AGENT` call. A missing or invalid key blocks the agent and instructs the user to fix their license.

### Remote browser agent
- `src/lib/remote-agent.js` now sends planner/navigator requests to the hosted backend.
- `src/background/sw.js` no longer builds the browser-agent plan/action prompts locally; instead it uploads compact page context plus the current license key and receives a single JSON decision back.
- `src/lib/prompts.js` was reduced to a generic assistant prompt for non-browser-agent flows, so the strongest planner/action system prompt is no longer bundled into the extension.

### Settings UI
- Added a **License & Activation** card in the Settings home and a dedicated subpage with:
  - Key validator + validation button (calls `/validate`).
  - Email input + **Request trial key** / **Request premium key** buttons (call `/trial` or `/premium`, autofill the returned key, and persist it to storage).
  - Status badge showing whether the stored key is valid and when it expires.
- The sidepanel now loads stored license info on startup and refreshes the status badge whenever a new key is saved.

### CSS
- New styles live in `src/sidepanel/sidepanel.css` for the badge, CTA buttons, and helper text.

## 3. Release checklist

1. Update Render's env vars: `MONGO_URI`, `LICENSE_RELEASE_DATE`, `AD_WATCH_SECRET`, (optional durations).
2. Seed Mongo Atlas with any initial licenses, if needed.
3. Deploy the backend (`npm install`, `npm run start`) on Render.
4. Adjust `DEFAULT_APP_BACKEND_URL` inside `src/lib/app-backend.js` if the API lives somewhere other than `https://opencomet.onrender.com`.
5. Share the trial/premium endpoints or a simple portal for users to request keys; the UI already calls these endpoints directly.
6. After release, ensure the ad partner can issue a signature for each daily challenge and instruct users to paste those daily keys into the license input when prompted.

With these pieces, the extension stops unless a license key validates against the server, and the same backend can scale (Render free tier + Mongo Atlas M0) before you upgrade to paid tiers.
