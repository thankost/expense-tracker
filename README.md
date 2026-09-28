# Expenses: a private income & expense tracker for iPhone

A simple, offline Progressive Web App (PWA). It runs from your iPhone Home Screen like a normal app, and all data stays on your phone.

## Features
- Income and expenses with **categories and subcategories** (add, rename, and delete your own)
- **Pay periods**: you choose the date each "month" starts (e.g. payday). A period ends the day before the next one starts. Before your first period, calendar months are used.
- **Overview**: balance, a donut chart by category, income vs. expenses for the last 6 periods, and budget progress
- **Breakdown**: totals per category, which expand to show subcategories
- **Budgets** per category, applied to each pay period
- **Recurring** transactions (monthly or weekly). They are added automatically when the app is opened.
- Notes on transactions
- **App lock**: a 4-digit PIN, plus optional Face ID (a device passkey)
- **Export CSV** (for Numbers/Excel) and **JSON backup / restore**
- Light and dark mode, and works offline

## Put it on your iPhone (GitHub Pages)
Offline installs on iOS need HTTPS, so the files are hosted on GitHub Pages, which is free. Only the app code is uploaded. Your data never leaves the phone.

1. Create a new repository on GitHub, e.g. `expense-tracker` (it can be public; it contains no data).
2. Push this folder:
   ```bash
   cd ~/WebstormProjects/expense-tracker
   git remote add origin https://github.com/<your-user>/expense-tracker.git
   git push -u origin main
   ```
3. On GitHub, open **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, select branch `main` and folder `/ (root)`, then Save. Wait about 1 minute.
4. On your iPhone, open **Safari** and go to `https://<your-user>.github.io/expense-tracker/`
5. Tap **Share** (the square with the arrow) → **Add to Home Screen** → **Add**.
6. Open **Expenses** from the Home Screen. From now on it works offline.

**First steps in the app:** Settings → **Pay periods** → add the date your last salary arrived. Then adjust **Categories** as you like.

> ⚠️ **Private repos:** GitHub Pages on a free account requires a public repo. That's fine, because only code is published.

## Updating the app
1. Change the code.
2. Increase `VERSION` in `sw.js` (e.g. `v1` → `v2`).
3. `git commit -am "update" && git push`
4. Open the app on the phone. It downloads the update in the background and reloads.

## Your data: important
- The data is stored in the app's own storage on the iPhone (IndexedDB).
- **Deleting the Home Screen icon deletes the data.** Use **Settings → Back up** regularly and save the file to iCloud Drive / Files. Restore it with **Settings → Restore**.
- The PIN / Face ID lock protects the app screen, but the stored data is not encrypted.
- Face ID uses a passkey created for this website. iOS may show it in the Passwords app as "Expenses app lock".

## Run locally on the Mac
```bash
cd ~/WebstormProjects/expense-tracker
npm start           # serves http://localhost:8000
npm test            # unit tests (period math, CSV)
```

## Structure
```
index.html              app shell + tab bar
manifest.webmanifest    PWA manifest
sw.js                   offline cache (bump VERSION on changes)
css/styles.css          iOS-style design, light/dark
js/app.js               UI, screens, sheets, logic
js/db.js                IndexedDB storage
js/periods.js           pay period & date math
js/charts.js            SVG donut & bar charts
js/lock.js              PIN + Face ID (WebAuthn)
js/export.js            CSV / share helpers
icons/                  app icons
tests/                  node:test unit tests
```
