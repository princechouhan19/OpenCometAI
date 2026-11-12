# License flow and deployment

The license service, how it is deployed, and how the extension talks to it.

## Backend service

Location: `Open Comet Web/backend/`.

**Stack.** Node.js, Express, Mongoose, MongoDB Atlas.

**Deployment.** Host on Render as a free web service with `Open Comet Web/backend`
as the service root and `npm start` as the command. Set `MONGO_URI` to an Atlas
M0 cluster, `LICENSE_RELEASE_DATE` to the UTC timestamp when trials expire,
`AD_WATCH_SECRET` for the ad flow, and `OPENAI_API_KEY` for the hosted agent.

**Endpoints**

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/licenses/trial` | `{ email }` | `{ key, license }`, expiry clamped to the release date |
| `POST /api/licenses/premium` | `{ email }` | A 30-day paid key |
| `GET /api/licenses/daily/challenge` | none | A short-lived challenge for the ad flow |
| `POST /api/licenses/daily` | `{ email, challenge, signature }` | A daily key; the ad partner must HMAC `email:challenge` with `AD_WATCH_SECRET` |
| `POST /api/licenses/validate` | `{ key }` | `{ valid, license }` |
| `POST /api/agent/browser/respond` | Browser context plus a valid license key | The planner and navigator JSON |

**Release flow.** Set `LICENSE_RELEASE_DATE` to the launch plus trial cutoff.
After that date trial requests are refused and existing trials validate as
expired. The daily ad flow only activates once the date has passed.

## Extension wiring

### Storage and validation

- License metadata lives under the `opencometLicense` storage key, through
  `getLicenseInfo` and `saveLicenseInfo` in `src/lib/storage.js`.
- `src/lib/license-service.js` centralises the `fetch` helpers.
- `src/background/sw.js` imports `validateLicenseKey` and runs `ensureLicense`
  before accepting a `START_AGENT` call. A missing or invalid key blocks the run
  and tells the user what to fix.

### Remote agent

- `src/lib/remote-agent.js` sends planner and navigator requests to the hosted
  backend.
- `src/background/sw.js` no longer builds those prompts locally; it uploads
  compact page context plus the license key and receives one JSON decision.
- `src/lib/prompts.js` was reduced to a generic assistant prompt for non-agent
  flows, so the strongest planner prompt is not bundled in the extension.

### Settings UI

- A License & Activation card on the Settings home, with a dedicated subpage.
- Key input with a validate button calling `/validate`.
- Email input with **Request trial key** and **Request premium key** buttons,
  which call `/trial` or `/premium`, autofill the key and persist it.
- A status badge showing validity and expiry.

### Styles

New rules in `src/sidepanel/sidepanel.css` cover the badge, the buttons and the
helper text.

## Release checklist

1. Set Render environment variables: `MONGO_URI`, `LICENSE_RELEASE_DATE`,
   `AD_WATCH_SECRET`, and any duration overrides.
2. Seed Atlas with initial licenses if needed.
3. Deploy the backend (`npm install`, `npm run start`).
4. Adjust `DEFAULT_APP_BACKEND_URL` in `src/lib/app-backend.js` if the API is
   not at `https://opencomet.onrender.com`.
5. Share the trial and premium endpoints, or a portal that uses them; the UI
   calls them directly.
6. After release, confirm the ad partner can sign each daily challenge and tell
   users to paste the returned key when prompted.
