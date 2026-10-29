# Cairn

A strength and athleticism tracker for the phone. It runs a 12-week program, logs sets with rest timers, tracks readiness and flare-ups, and shows progress over time. It installs to the iPhone Home Screen and works offline.

Live app: https://jake-tests-stuff.github.io/Cairn/

## Features

- Daily plan with sets, reps, RPE and rest timers (sound and vibration, plus a locked-screen alert)
- 11 built-in plans, a custom plan builder, and reusable workout templates
- Exercise library with primary and secondary muscles, and a muscle map
- Weekly review: tonnage per day, lift days, sets, and readiness
- Deload prompts, readiness-based set adjustments, and flare-up tracking
- Plate sheet: tap a weight to see what to load on each side
- Light and dark themes, accent colors, miles or kilometers
- Backup export and import

## How it's built

| Piece | What it is |
| --- | --- |
| `index.html` | The whole app: markup, styles and scripts in one file |
| `sw.js` | Service worker. Offline cache and push notification handlers |
| `cairn-db.js` | Bundled Firebase layer. Generated from `src/db.js`, don't edit by hand |
| `src/db.js` | Firebase sign-in and Firestore access |
| `firestore.rules` | Security rules, pasted into the Firebase console |
| `manifest.json`, `icon-*.png` | Home Screen install details |
| `worker/` | Cloudflare Worker for push notifications (see below) |
| `index.pre-batch1.html`, `index.pre-redesign.html` | Older working versions of the app, kept as fallbacks |

Data lives in Firebase (Firestore). Sign-in is Google only and locked to a single account through the security rules. The app is hosted on GitHub Pages from the `main` branch.

## Running and changing it

There is no build step for the app itself. Edit `index.html`, commit to `main`, and GitHub Pages publishes it within a minute or two.

If `src/db.js` changes, rebuild the bundle:

```
npm install
npm run build
```

If a changed file seems stuck on the phone, bump `CACHE` in `sw.js` (for example `cairn-v3` to `cairn-v4`) so the old cache is dropped.

To test locally, serve the folder with any static server, for example `python3 -m http.server 8765`.

## Push notifications

The `worker/` folder is a small Cloudflare Worker. It sends the alerts that arrive with the phone locked: the rest timer, an optional morning check-in, and an optional Sunday review. It uses standard Web Push with VAPID keys, and it only accepts requests that carry a valid Firebase sign-in token for the allowed account.

Deploying it on Cloudflare:

1. Create a Worker from this GitHub repo (Workers & Pages, Import a repository).
2. In the build settings, set the root directory to `worker`, leave the build command empty, and keep the deploy command as `npx wrangler deploy`.
3. Add a secret named `VAPID_PRIVATE_JWK` holding the private half of your VAPID key pair (an ES256 / P-256 key in JWK format).
4. Put the matching public key in `worker/wrangler.toml` as `VAPID_PUBLIC`, and set `ALLOWED_EMAILS`, `ALLOWED_ORIGIN` and `FIREBASE_PROJECT` to your values.
5. Set `PUSH_URL` near the top of the push section of `index.html` to your Worker's address.

The Worker needs the `worker/package-lock.json` file, because Cloudflare installs with `npm ci`.

Tests for the Worker (encryption, signing, token checks, scheduling) run with:

```
cd worker
npm test
```

On iPhone, notifications need iOS 16.4 or later and the app installed to the Home Screen.

## Backups

Settings has Export backup and Import backup. Export saves every collection to a JSON file. Do it now and then, since the data is only as safe as the Firebase project it lives in.

## Limits to know about

- Lifting weights are in pounds. Distances can switch between miles and kilometers.
- Built as a personal tracker. Multi-user support would need per-user data paths, new security rules, open sign-in, and a privacy policy.
- iOS web apps cannot vibrate. Sound plays on silent through an audio element, and the locked-screen alert comes from the push server.
