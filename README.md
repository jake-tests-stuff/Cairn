# Cairn

Strength and athleticism tracker. Static PWA on GitHub Pages, data in Firebase (Firestore), sign-in locked to one Google account.

- `index.html` is the whole app.
- `src/db.js` is the Firebase layer; `npm run build` bundles it into `cairn-db.js`.
- `firestore.rules` is what's pasted into the Firebase console.
- `sw.js` is the offline cache. Bump `CACHE` if a stale file ever sticks.
