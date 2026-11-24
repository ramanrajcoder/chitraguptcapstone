# ChitRagupt v2.1 — hosted edition

Inventory, GST billing and accounting for small Indian shops. Same vanilla HTML/CSS/JS app as before, now with:
a real database (Neon Postgres), real login (login id + password), multi-device sync, English/हिंदी, hosted free on Vercel.

```
landing.html  index.html  style.css  script.js     the app (script.js: DB layer rewritten, money/ledger code untouched)
i18n.js  sync.js                                    t() helper | sync + login + import
i18n/en.json  hi.json  languages.json               UI text
api/        health, data, sync, import, translate, auth/{register,login,logout}   (Vercel Functions, Node 20)
lib/        db, auth, http, schemas (zod)
schema.sql                                          your final schema, used exactly as is
scripts/    build-i18n.mjs  generate-i18n.mjs  extract-ui.mjs  core-strings.mjs  ui-hi.mjs
tests/      api.test.mjs  e2e.mjs  harness.mjs  dev-server.mjs
vercel.json  package.json  .env.example  .gitignore
```

---

## 0. Read this first: what could ever cost money

| Service | Free? | Can it charge you? |
|---|---|---|
| **GitHub** | Free | No. |
| **Neon** (database) | Free plan, no card needed | No. At the limit it stops/slows, it does not bill (never add a card or upgrade). |
| **Vercel** | **Hobby** plan is free, no card | No overage billing on Hobby: it pauses when limits are hit. **But Vercel's terms limit Hobby to personal, non-commercial use.** If you will charge shops for this app, check Vercel's terms or move to a paid plan. |
| **Google Cloud Translation** | 500,000 characters/month free | **YES, this is the only one that can charge.** It needs a billing account with a card, and after 500,000 characters it costs about US$20 per million. Section 5 shows how to cap it. **You can skip Google entirely** (see 5.5): the app works fully without it. |

Free-tier limits change. Re-check neon.com/pricing and vercel.com/pricing before launch.

---

## 1. Put the code on GitHub (5 min)

1. Create a free account at github.com. Click **New repository**, name it `chitragupt`, set **Private**, click **Create**.
2. On your computer unzip `chitragupt-v2.zip`. In the repository page click **uploading an existing file**, drag in **everything inside** the folder (including the `api`, `lib`, `i18n`, `scripts`, `tests` folders), click **Commit changes**.
   Check that `package.json` and `index.html` are at the top level of the repo, not inside a sub-folder.
3. Never upload a file called `.env`. (`.gitignore` already blocks it.)

## 2. Create the database on Neon and run `schema.sql` (5 min)

1. neon.com → **Sign up** (GitHub login works). **Create project**: name `chitragupt`, pick the region closest to your shops (e.g. AWS Mumbai `ap-south-1` if offered, otherwise Singapore).
2. Open **SQL Editor** (left menu). Open `schema.sql` from this project in any text editor, copy **all** of it, paste, press **Run**. You should see success messages. (It is safe to run twice.)
3. On the project dashboard click **Connect**, copy the connection string. It looks like `postgresql://user:password@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require`. Keep it secret: this is `DATABASE_URL`.

## 3. Deploy on Vercel (5 min)

1. vercel.com → **Sign up with GitHub** → choose the **Hobby** plan.
2. **Add New → Project** → import the `chitragupt` repo.
3. Framework Preset: **Other**. Leave Build Command and Output Directory **empty**. Do not open "Override" boxes.
4. Open **Environment Variables** and add (names exactly as shown):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Neon string from step 2.3 |
   | `JWT_SECRET` | 48+ random characters. Make one: in a terminal `openssl rand -base64 48`, or type a very long random sentence |
   | `MONTHLY_CHAR_CAP` | `400000` |
   | `GOOGLE_TRANSLATE_API_KEY` | leave out for now (section 5) |

5. Click **Deploy**. When it finishes, open `https://YOUR-PROJECT.vercel.app/api/health`. You should see `{"ok":true,"db":"ok",...}`. If `db` is `error`, re-check `DATABASE_URL` and that `schema.sql` ran; if `jwtSecret` is false, the secret is missing or shorter than 32 characters. After changing a variable: **Deployments → ⋯ → Redeploy**.
6. Open `https://YOUR-PROJECT.vercel.app/` → landing page → **Get Started** → **Create an account**.

Optional: in Vercel → Settings → Functions, pick the region nearest to your Neon region (e.g. Mumbai `bom1`) to make saving faster.

## 4. Existing users: import your old data once

1. Open the new site **in the same browser** that held your old ChitRagupt data. Create your account.
2. Because the account is empty and old data is found, you see **Import my existing local data**. Click **Import data from this browser**. (Or choose **Import from a backup file** and pick a Backup-export `.json`.)
3. Check Dashboard totals against what you remember. The old data is NOT deleted automatically. After you are happy, delete the old copy (it contains your old plain-text PIN) via the prompt or **Settings → Account & Security → Delete old local copy**.
4. Do not import the same data into a second account: you would have two copies. The server refuses a second import into an account that already has records.

## 5. Google Translation (OPTIONAL: only for typed text and extra languages)

What it is used for:
* `/api/translate`: translates only user-typed descriptions (currently expense descriptions) when the app is in a non-English language. Numbers, amounts, dates, invoice numbers, GSTIN, e-mails, product and customer names are never sent.
* `scripts/generate-i18n.mjs`: a one-time script that translates the fixed UI text into a **new** language. (Hindi is already included, you do not need Google for it.)

### 5.1 Create the key without risking a bill
1. console.cloud.google.com → create a **new project** `chitragupt-translate`.
2. **Billing** → link a billing account (Google asks for a card even for the free tier). New accounts may get free credits.
3. **APIs & Services → Library** → search **Cloud Translation API** → **Enable**.
4. **APIs & Services → Credentials → Create credentials → API key**. Click the new key → **Edit**:
   * **API restrictions → Restrict key → tick only "Cloud Translation API"** → Save.
   * (Optional) Application restrictions: none (the key is used only from Vercel's servers and your own computer).
5. Copy the key into Vercel as `GOOGLE_TRANSLATE_API_KEY` and redeploy.

### 5.2 Set a hard quota (this is what really stops charges)
1. **IAM & Admin → Quotas & System Limits** → filter **Cloud Translation API**.
2. Find the quota whose name contains **"Characters per day"** (v2 / basic). Click it → **Edit quota** → set a value like **15,000** per day (about 450,000/month, under the free 500,000). Save. Also lower "characters per minute" if offered.
   Once the quota is reached Google refuses further calls instead of billing them.
3. The app adds its own second wall: `MONTHLY_CHAR_CAP` (default 400,000), counted in the `usage_counter` table. When it is reached, text simply stays as typed.

### 5.3 Budget alert (a warning, not a brake)
**Billing → Budgets & alerts → Create budget** → amount **₹100 / $1** → alert at 50%, 90%, 100% to your e-mail. Budgets only e-mail you; they do **not** stop spending. The quotas in 5.2 are the brake.

### 5.4 Generate another language (one time, on your computer)
```bash
npm install
GOOGLE_TRANSLATE_API_KEY=your-key node scripts/generate-i18n.mjs mr "मराठी" MR    # Marathi
node scripts/generate-i18n.mjs gu --dry                                            # only count characters, no Google call
```
Each language costs about 12,000 characters (~2% of one free month). It writes `i18n/mr.json` and adds the language to `i18n/languages.json`. Read the result once: machine translation of accounting words can be awkward; edit the JSON freely. Commit and push; Vercel redeploys.
**New language = one JSON file** (+ one line in `i18n/languages.json`, which the script adds for you). The language button cycles through every language in that list.

### 5.5 If you skip Google entirely
Do nothing: leave `GOOGLE_TRANSLATE_API_KEY` unset. English and Hindi menus/labels work from the files in `i18n/`. Typed text is shown exactly as typed. No card, no billing account, no risk.

---

## 6. How the data layer works (so you can trust it)

* On login the browser loads **all** your business data into memory (`GET /api/data`). `DB.get/DB.set` are still **synchronous**; all 165 call sites are unchanged.
* `DB.set` updates memory, mirrors to `localStorage` (offline cache, per business) and queues **one** debounced save about 0.5 s later.
* `atomic(keys, fn)` snapshots every key it touches. If `fn` throws, memory, cache and the queue are restored exactly and **nothing is sent**. If it succeeds, **all changed keys travel in one `POST /api/sync`** and are written in **one SQL statement/transaction** (all or nothing).
* Every key carries a **version**. A write is accepted only if its version is the one the server has. Otherwise: `409`, nothing is saved, the app **discards all pending local changes, reloads everything** and shows a clear message. (Reloading only the conflicting key would risk a bill saved without its ledger lines.)
* `business_id` is read from the signed cookie only. Request bodies cannot name another business.
* Money stays integer paise end to end; the server rejects non-integer ledger amounts. Ledger posting, `Calc`, schema-version constants and `migrateV1toV2` are untouched.
* Not synced on purpose: `meta` (backup counters) and `snapshots` (last 5 safety snapshots) stay in this browser. They are not in your schema.
* Big saves are gzip-compressed (the app → server body and server → app reply) to stay under Vercel's 4.5 MB request/response limit.
* No polling. The app re-checks versions only when you come back to the tab after 30+ seconds (polling would keep Neon awake and burn the free compute hours).

## 7. Places where data could be lost, mismatched or double-counted

1. **Two devices editing at once.** The later save is refused (409) and its entry is discarded after the reload message. Re-enter it. Example: a bill printed on device B that then fails to save. Mitigation: use one device at the counter; other devices for viewing/reports. The status badge in the top bar shows **Saved / Saving / Offline / NOT saved**: do not hand over a printed bill while it says NOT saved.
2. **Closing the tab with the badge not "Saved".** The browser warns you. If you ignore it, unsent changes stay in the offline cache and are re-sent next login **only if** nobody changed the same data meanwhile; otherwise they are dropped with a message.
3. **Offline.** If the connection drops while the app is open you can keep billing; changes queue and send when back online. Reloading the page while offline does **not** work (there is no service worker), and the offline copy is only a cache, not a backup.
4. **Session expiry (7 days) mid-work.** A "session expired" box appears; unsent changes are kept and saved after you log in again.
5. **Import done twice / into two accounts** = double-counted. The server blocks the second import into the same account; you must not import the same file into two accounts.
6. **Shared computer.** Logout wipes the offline copy. Without logout, anyone using that browser is logged in (cookie lasts 7 days).
7. **No password reset yet.** A forgotten password cannot be recovered (there is no e-mail field in the schema). Write it down. A reset could be added by editing the `password_hash` in Neon with a new bcrypt hash.
8. **Neon free database inactive for a long time** can be paused by Neon; first request after a pause takes a few seconds.
9. **Backups.** Neon free keeps only a short history. Keep using **Settings → Download backup**: it is your off-site copy.
10. Backup banner/schedule counters (`meta`) are per browser, so each device reminds you separately.

## 8. Free-tier limits you could hit

* **Vercel request/response size 4.5 MB** per call. A key is one JSON document, and the whole `ledger` is rewritten on each bill. With gzip this is comfortable for tens of thousands of bills, but if you ever see "too large to save", download a backup, start a fresh financial year in a new account and import nothing, or ask a developer to split `ledger` by year.
* **Neon storage / compute hours.** Each save rewrites whole documents (old row versions are cleaned by Postgres). A normal shop stays far below the storage limit; the compute limit is why there is no polling. Watch the **Neon dashboard → Usage**.
* **Vercel Hobby:** function invocation/duration limits and the non-commercial-use rule (section 0).
* **Google:** 500,000 characters per month (capped at 400,000 by the app, and by your Google quota).
* **Login attempts table** grows slowly; it self-cleans entries older than a day. Sign-ups are limited to 10 per hour per network.
* bcrypt cost is 10 and runs in plain JavaScript (about 100 ms per login). Fine for this size.

## 9. Test it yourself (10 min)

Locally, without any cloud: `npm install`, then `npm test` (31 API checks against a real Postgres engine running in memory), `node tests/e2e.mjs` (15 browser checks), or `npm run dev` and open http://127.0.0.1:3000/landing.html (data is lost when you stop it).

After deploying, tick every box:

- [ ] **Create account:** register → app opens, badge says "Saved", your name shows top right.
- [ ] **Bill, return, payment:** Inventory → add product (price ₹100, GST 18%, stock 50) · Customers → add one · POS → sell 2 on part-credit · Customers → record a payment · Bill History → return 1 item. Note Dashboard, Balance Sheet and GST totals.
- [ ] **Reload** the page: same totals.
- [ ] **Second browser** (or phone): log in with the same login id and password: **identical totals** on Dashboard, Balance Sheet, GST, Customer outstanding.
- [ ] **Two-device conflict:** change a product's stock on device A; on device B (not refreshed) change the same product: B shows the red "NOT saved" message, reloads, and shows A's value.
- [ ] **Failed-write rollback:** in POS try selling more than the stock (error shown, stock and totals unchanged, badge stays "Saved"). Developer check: browser console `try{atomic(['products'],()=>{DB.set('products',[]);throw 1})}catch{}; DB.get('products').length` still shows your products.
- [ ] **Offline:** turn on airplane mode, make a bill → badge "Offline: will retry"; turn it off → it saves.
- [ ] **Wrong-password limit:** log out, enter a wrong password 5 times → "Too many wrong attempts, wait 15 minutes", even the right password is refused until then.
- [ ] **No secrets in the browser:** DevTools → Application → Cookies: `cr_session` is **HttpOnly, Secure, SameSite=Strict**; `document.cookie` in the console is empty; Local Storage has no password or token; View Source/Network shows no `DATABASE_URL`, `JWT_SECRET` or Google key.
- [ ] **Hindi:** language button → menus, titles and most labels switch; amounts, dates, invoice numbers, product/customer names do not change.
- [ ] **Backups, PDF, print:** Settings → Download backup; open a bill → Print and PDF still work.

## 10. Known limits of this release

* The long **User Manual** text, some sentences built from live numbers (for example "5 orders · ₹1,000 billed"), browser pop-ups (`confirm()` dialogs) and toast messages other than the sync/login ones stay English. Fixed labels (menus, headings, buttons, table headings, form labels, placeholders) are translated. To translate more, add the English sentence to `scripts/core-strings.mjs` or `scripts/ui-hi.mjs` and run `node scripts/build-i18n.mjs`.
* A product or customer whose name is exactly a fixed label (for example a product called "Cash") could be shown translated. Names are otherwise never touched.
* No password reset and no change-password screen yet.
* The CDN libraries (Chart.js, html2pdf) and Google Fonts are loaded from the internet without integrity hashes (as in the original).
* `rm`-style account deletion is not provided.
* The server code was tested on an in-memory Postgres (PGlite, the same SQL engine family) with your exact `schema.sql`, not on Neon/Vercel themselves. `/api/health` is your first live check.
