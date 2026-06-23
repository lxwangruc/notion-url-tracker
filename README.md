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
- **Status** — **Unread** (default), **Read**, **Archived**, or **Trash**.
- **Recent list in the popup** — see your last 10 saves and flip Read/Unread
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
3. **Step 2 — Choose database:** select the parent page you shared above →
   **Create database**. The database is created **inline**, so it shows up as a
   live table embedded in that page (not just a link). (Or expand "Use an
   existing database instead" and paste a database ID.)
4. **Step 3 — Predefined tags:** optionally enter your common tags (one per line).

## 5. Save pages

1. Open any article and click the extension icon.
2. The popup reads the page, adds/edits tags, and lets you set Unread/Read.
3. Click **Save** — the entry appears in your Notion database, with the article
   text in the page body.

---

## Notion database schema

The auto-created database has these properties:

| Property | Type         | Notes                          |
| -------- | ------------ | ------------------------------ |
| Name     | Title        | Article/page title             |
| URL      | URL          | The saved link                 |
| Tags     | Multi-select | Your tags                      |
| Status   | Select       | `Unread` (default) / `Read`    |
| Site     | Text         | Source site name               |
| Saved    | Date         | When you saved it              |

If you bring your **own** database, it must contain (at least) properties named
`URL`, `Tags`, and `Status` for duplicate detection and saving to work.

## Reading on mobile

Open the same database in the Notion mobile app. To add links manually, create a
new row and paste the URL, or use your phone's **Share** sheet → Notion to send a
link into the database.

## Privacy & storage

Your token, database ID, and predefined tags are stored only in the browser via
`chrome.storage.local`. The extension requests `activeTab` (to read the page you
explicitly save) and host access to `https://api.notion.com/*` only.

## Project layout

```
manifest.json        MV3 manifest
popup.html/.js/.css  Save flow (the one-click popup)
options.html/.js/.css Setup: token, database, tags
notion.js            Notion API client (shared)
lib/Readability.js   Mozilla Readability (vendored, Apache-2.0)
icons/               Toolbar icons
```

## Troubleshooting

- **"Could not list pages."** — Make sure you shared at least one page with the
  integration (Step 2) and the token is correct.
- **Nothing extracted / empty body** — Some pages (PDFs, internal `edge://`
  pages, login walls) can't be read; the URL and title are still saved.
- **Saving fails with a property error** — Your existing database is missing one
  of the required properties (`URL`, `Tags`, `Status`).
