# Notion URL Tracker — Read Later

A Microsoft Edge (Manifest V3) extension that saves the current page to a Notion
database for "read later", synced across all your devices through Notion itself.

- **One click → popup → add tags → save.** Keeps the URL and extracts the
  readable article text (via Mozilla Readability) into the Notion page body.
- **Keyboard shortcuts** — <kbd>Ctrl/⌘+Shift+U</kbd> opens the popup;
  <kbd>Ctrl/⌘+Shift+S</kbd> instantly saves the current page with defaults.
- **Right-click to save** — "Save link to Notion" on any link (stored as a
  bookmark preview), or "Save this page to Notion" from the page menu.
- **Selection capture** — if you've highlighted text, it's saved as a quote/note
  at the top of the entry (and shown in the popup so you can edit it first).
- **Tags** — pick from a predefined list or add new ones on the fly.
- **Status, Favourite & Archive** — set the entry's status and toggle
  Favourite/Archive (the available statuses are read from your database).
- **Recent list in the popup** — see your last 10 saves and flip status
  inline, so the popup doubles as a mini reading list.
- **Edit-after-save** — open the popup on a page you already saved to change its
  tags/status (or append a new quote) without leaving the browser.
- **Saved indicator** — a dot on the toolbar icon when the current page is
  already in your database (toggleable in settings).
- **Cover image, author & published date** — pulled from the page automatically.
- **Multiple profiles** — keep separate Notion targets (e.g. Work / Personal)
  and choose which one to save to from the popup.
- **Duplicate detection** — saving a known URL switches the popup to edit mode.
- **Mobile** — just use the official Notion app to add or share links into the
  same database. No separate app needed.

The extension talks **directly** to the Notion API using your personal internal
integration token. There is no server and nothing leaves your machine except
the calls to `api.notion.com`.

---

## 1. Create a Notion integration

1. Go to <https://www.notion.so/my-integrations> and click **New integration**.
2. Give it a name (e.g. "Read Later"), choose your workspace, and create it.
3. Copy the **Internal Integration Secret** (starts with `ntn_` or `secret_`).

## 2. Share a parent page with the integration

The Notion API can't create a top-level database on its own — it needs a parent
page it has access to.

1. In Notion, create (or pick) a page to hold your read-later list, e.g.
   "Read Later".
2. Open that page → **•••** (top-right) → **Connections** → add your integration.

## 3. Load the extension in Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (bottom-left).
3. Click **Load unpacked** and select this `notion-url-tracker` folder.
4. Pin the extension so its icon is visible on the toolbar.

## 4. Configure it

1. Click the extension icon → **Open settings** (or right-click → **Options**).
2. **Step 1 — Connect Notion:** paste your integration token → **Save & connect**.
3. **Step 2 — Choose database** — two options:
   - **Use the Link Tracker template** (recommended): in Notion, open the
     [Link Tracker template](https://elite-carver-cc0.notion.site/Link-Tracker-1b8eed27689980c3b61fca1ec71f3231),
     click **Duplicate** (top-right) to copy it into your workspace, share that
     page with your integration, then in settings pick its **Links** database
     from the **"select an existing database"** dropdown. A `Tags` property is
     added automatically if it's missing.
   - **Create a fresh one:** expand "Or create a brand-new database", pick a
     parent page, and **Create database** (created inline as a live table).
4. **Step 3 — Predefined tags:** optionally enter your common tags (one per line).
5. **Settings:** choose how page content is stored, and toggle the saved-indicator.

## 5. Save pages

1. Open any article and click the extension icon (or press the shortcut).
2. The popup reads the page; add tags, set the Status, and toggle
   Favourite/Archive.
3. Click **Save** — the entry appears in your Notion database, with the article
   text in the page body.

---

## Notion database schema

This extension is **schema-aware**: it reads your database's properties and only
writes the ones that exist, so it works with the **Link Tracker template** as-is
(plus an auto-added `Tags` property).

**Required:** a `title` property, a `URL` (url) property, and a `Status`
property (either a *Status*-type or a *Select*; its options are read from the
database). **Used if present:** `Tags` (multi-select), `Favourite`/`Archive`
(checkbox), `Type` (select), `Site`/`Author` (text), `Published`/`Saved` (date).

The extension's own auto-created database uses these properties:

| Property         | Type         | Notes                              |
| ---------------- | ------------ | ---------------------------------- |
| Name             | Title        | Article/page title                 |
| URL              | URL          | The saved link                     |
| Status           | Select       | `Inbox` (default)/`To review`/`Reviewed` |
| Type             | Select       | Video/Article/Podcast/…            |
| Tags             | Multi-select | Your tags                          |
| Favourite        | Checkbox     |                                    |
| Archive          | Checkbox     |                                    |
| Site             | Text         | Source site name                   |
| Saved            | Date         | When you saved it                  |

## Reading on mobile

Open the same database in the Notion mobile app. To add links manually, create a
new row and paste the URL, or use your phone's **Share** sheet → Notion to send a
link into the database.

## Privacy & storage

Your token, database ID, and predefined tags are stored only in the browser via
`chrome.storage.local`. The extension requests `activeTab` (to read the page you
explicitly save) and host access to `https://api.notion.com/*` only.

## Migrating from an old database

If you have entries in an earlier database (for example one the extension
auto-created before you switched to the Link Tracker template), you can copy
them into the new database with the included script. It copies each row's
title, URL, tags, status, Favourite/Archive flags, and the full page body
(the saved article text), and it skips rows whose URL already exists in the
target so it is safe to re-run.

1. Make sure your Notion integration is shared with **both** databases
   (open each database → ••• → **Connections** → add your integration).
2. Get each database's ID from its URL — open the database as a full page; the
   32-character chunk before `?v=` is the ID.
3. Run (requires Node 18+):

   ```bash
   NOTION_TOKEN=secret_xxx \
   SOURCE_DB=<old-database-id> \
   TARGET_DB=<new-database-id> \
   node tools/migrate.mjs
   ```

   Optional flags: `DRY_RUN=1` (preview only, writes nothing),
   `NO_BODY=1` (copy properties only, skip page bodies),
   `NO_DEDUPE=1` (don't skip rows already in the target).

Status values are mapped to the template's options (Unread→Inbox, Read→Reviewed,
Archived/Trash→Archive checkbox, etc.). Edit `STATUS_MAP` at the top of
`tools/migrate.mjs` if you want a different mapping.

## Project layout

```
manifest.json        MV3 manifest
background.js         Service worker: shortcuts, context menu, badges
popup.html/.js/.css  Save flow (the one-click popup)
options.html/.js/.css Setup: profiles, database, tags, settings
notion.js            Schema-aware Notion API client (shared)
store.js             Profiles + settings (chrome.storage.local)
extract.js           Page content extraction (Readability)
lib/Readability.js   Mozilla Readability (vendored, Apache-2.0)
tools/migrate.mjs    One-off DB→DB migration script (Node)
icons/               Toolbar icons
```

## Troubleshooting

- **"Could not list pages."** — Make sure you shared at least one page with the
  integration (Step 2) and the token is correct.
- **Nothing extracted / empty body** — Some pages (PDFs, internal `edge://`
  pages, login walls) can't be read; the URL and title are still saved.
- **Saving fails with a property error** — Your database is missing a required
  property (a title, `URL`, or `Status`). The options page warns you about this
  when you select the database.
- **The template's Links database doesn't appear in the dropdown** — make sure
  you shared the duplicated page with your integration; otherwise copy the
  database's link in Notion and paste its ID under "Or paste a database ID".
- **YouTube (and similar) links** save just the title + URL (and thumbnail
  cover) — no noisy page-text dump.
