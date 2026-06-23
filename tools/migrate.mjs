#!/usr/bin/env node
// migrate.mjs — one-off migration of entries from an old Notion database into a
// new one (e.g. the "Link Tracker" template's Links database).
//
// It copies, for every row in the source database:
//   • Title + URL
//   • Tags (multi-select)
//   • Status (mapped to the target's options — see STATUS_MAP below)
//   • Favourite / Archive checkboxes
//   • Site / Author / Published / Saved (only if those columns exist on both)
//   • The full page body (the saved article text and any other blocks)
//
// It only writes properties that actually exist on the *target* database, and it
// skips rows whose URL is already present in the target (so it is safe to re-run).
//
// ---------------------------------------------------------------------------
// USAGE
//   1. Open your integration at https://www.notion.so/my-integrations, copy the
//      "Internal Integration Secret".
//   2. Make sure that integration is shared with BOTH databases
//      (open each database → ••• → Connections → add your integration).
//   3. Get each database's ID from its URL. Open the database as a full page;
//      the URL looks like  https://www.notion.so/<workspace>/<32-hex-chars>?v=...
//      The 32-char chunk before "?v=" is the database ID.
//   4. Run:
//        NOTION_TOKEN=secret_xxx \
//        SOURCE_DB=<old-database-id> \
//        TARGET_DB=<new-database-id> \
//        node tools/migrate.mjs
//
//   Optional flags (env vars):
//        DRY_RUN=1      Show what would happen, write nothing.
//        NO_BODY=1      Copy properties only, skip page bodies (faster).
//        NO_DEDUPE=1    Don't skip rows already present in the target.
// ---------------------------------------------------------------------------

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Map source status values (lower-cased) to a target status. Use the special
// value "__archive__" to instead tick the Archive checkbox. Anything not listed
// falls back to the target's first status option.
const STATUS_MAP = {
  unread: "Inbox",
  inbox: "Inbox",
  "to-do": "Inbox",
  todo: "Inbox",
  "to review": "To review",
  "in progress": "To review",
  read: "Reviewed",
  reviewed: "Reviewed",
  done: "Reviewed",
  complete: "Reviewed",
  archived: "__archive__",
  trash: "__archive__",
};

const TOKEN = process.env.NOTION_TOKEN;
const SOURCE_DB = process.env.SOURCE_DB;
const TARGET_DB = process.env.TARGET_DB;
const DRY_RUN = !!process.env.DRY_RUN;
const NO_BODY = !!process.env.NO_BODY;
const NO_DEDUPE = !!process.env.NO_DEDUPE;

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!TOKEN) die("NOTION_TOKEN is required.");
if (!SOURCE_DB) die("SOURCE_DB (old database id) is required.");
if (!TARGET_DB) die("TARGET_DB (new database id) is required.");

// ---- Low-level fetch with basic rate-limit handling -------------------------

async function notionFetch(path, { method = "GET", body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${NOTION_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get("retry-after") || 1) * 1000;
      await sleep(wait);
      continue;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const message =
        (data && (data.message || data.code)) ||
        `Notion request failed (HTTP ${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plainTitle = (arr) => (arr || []).map((t) => t.plain_text).join("");

// ---- Schema -----------------------------------------------------------------

async function getSchema(databaseId) {
  const db = await notionFetch(`/databases/${databaseId}`);
  const props = db.properties || {};
  const byName = {};
  const s = {
    byName,
    titleName: null,
    urlName: null,
    statusName: null,
    statusType: null,
    statusOptions: [],
    tagsName: null,
    typeName: null,
    favouriteName: null,
    archiveName: null,
    siteName: null,
    authorName: null,
    publishedName: null,
    savedName: null,
    dbTitle: plainTitle(db.title),
  };
  for (const [name, prop] of Object.entries(props)) {
    byName[name] = prop.type;
    switch (prop.type) {
      case "title":
        s.titleName = name;
        break;
      case "url":
        if (!s.urlName) s.urlName = name;
        break;
      case "status":
        if (name === "Status" || !s.statusName) {
          s.statusName = name;
          s.statusType = "status";
          s.statusOptions = (prop.status.options || []).map((o) => o.name);
        }
        break;
      case "select":
        if (name === "Status") {
          s.statusName = name;
          s.statusType = "select";
          s.statusOptions = (prop.select.options || []).map((o) => o.name);
        } else if (name === "Type") {
          s.typeName = name;
        }
        break;
      case "multi_select":
        if (name === "Tags" || !s.tagsName) s.tagsName = name;
        break;
      case "checkbox":
        if (/^favou?rite$/i.test(name)) s.favouriteName = name;
        else if (/^archive$/i.test(name)) s.archiveName = name;
        break;
      case "rich_text":
        if (name === "Site") s.siteName = name;
        else if (name === "Author") s.authorName = name;
        break;
      case "date":
        if (name === "Published") s.publishedName = name;
        else if (name === "Saved") s.savedName = name;
        break;
      default:
        break;
    }
  }
  return s;
}

// ---- Read a source row into a normalized shape ------------------------------

function parseRow(page) {
  const props = page.properties || {};
  const row = {
    id: page.id,
    title: "",
    url: "",
    tags: [],
    status: "",
    favourite: false,
    archive: false,
    type: "",
    site: "",
    author: "",
    published: null,
    saved: null,
    image: page.cover ? coverUrl(page.cover) : null,
  };
  for (const [name, prop] of Object.entries(props)) {
    switch (prop.type) {
      case "title":
        row.title = plainTitle(prop.title);
        break;
      case "url":
        if (prop.url && !row.url) row.url = prop.url;
        break;
      case "multi_select":
        if (name === "Tags") row.tags = prop.multi_select.map((o) => o.name);
        break;
      case "status":
        if (prop.status) row.status = prop.status.name;
        break;
      case "select":
        if (name === "Status" && prop.select) row.status = prop.select.name;
        else if (name === "Type" && prop.select) row.type = prop.select.name;
        break;
      case "checkbox":
        if (/^favou?rite$/i.test(name)) row.favourite = prop.checkbox;
        else if (/^archive$/i.test(name)) row.archive = prop.checkbox;
        break;
      case "rich_text":
        if (name === "Site") row.site = plainTitle(prop.rich_text);
        else if (name === "Author") row.author = plainTitle(prop.rich_text);
        break;
      case "date":
        if (name === "Published" && prop.date) row.published = prop.date.start;
        else if (name === "Saved" && prop.date) row.saved = prop.date.start;
        break;
      default:
        break;
    }
  }
  return row;
}

function coverUrl(cover) {
  if (!cover) return null;
  if (cover.type === "external") return cover.external?.url || null;
  if (cover.type === "file") return cover.file?.url || null;
  return null;
}

// ---- Map a source row to target properties ----------------------------------

function mapStatus(sourceStatus, target) {
  const result = { status: undefined, archive: false };
  const key = (sourceStatus || "").trim().toLowerCase();
  let want = STATUS_MAP[key];
  if (want === "__archive__") {
    result.archive = true;
    want = null;
  }
  if (!target.statusName) return result;
  const opts = target.statusOptions;
  // exact (case-insensitive) match against target options first
  let match =
    opts.find((o) => o.toLowerCase() === (want || key)) ||
    opts.find((o) => o.toLowerCase() === key);
  if (!match && want) match = opts.find((o) => o.toLowerCase() === want.toLowerCase());
  result.status = match || opts[0] || undefined;
  return result;
}

function buildProperties(target, row) {
  const p = {};
  if (target.titleName)
    p[target.titleName] = { title: [textNode(row.title || row.url || "")] };
  if (target.urlName && row.url) p[target.urlName] = { url: row.url };
  if (target.tagsName && row.tags.length)
    p[target.tagsName] = { multi_select: row.tags.map((name) => ({ name })) };

  const { status, archive } = mapStatus(row.status, target);
  if (target.statusName && status) {
    p[target.statusName] =
      target.statusType === "status" ? { status: { name: status } } : { select: { name: status } };
  }
  if (target.favouriteName) p[target.favouriteName] = { checkbox: !!row.favourite };
  if (target.archiveName) p[target.archiveName] = { checkbox: !!(row.archive || archive) };

  if (target.typeName && row.type)
    p[target.typeName] = { select: { name: row.type } };
  if (target.siteName && row.site)
    p[target.siteName] = { rich_text: [textNode(row.site)] };
  if (target.authorName && row.author)
    p[target.authorName] = { rich_text: [textNode(row.author)] };
  if (target.publishedName && row.published)
    p[target.publishedName] = { date: { start: row.published } };
  if (target.savedName)
    p[target.savedName] = { date: { start: row.saved || new Date().toISOString() } };
  return p;
}

const textNode = (content) => ({ type: "text", text: { content: String(content).slice(0, 2000) } });

// ---- Pagination helpers -----------------------------------------------------

async function listAllRows(databaseId) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${databaseId}/query`, {
      method: "POST",
      body,
    });
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

async function listAllBlocks(blockId) {
  const out = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const data = await notionFetch(`/blocks/${blockId}/children${qs}`);
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

async function findByUrl(databaseId, url, urlName) {
  if (!urlName || !url) return null;
  const data = await notionFetch(`/databases/${databaseId}/query`, {
    method: "POST",
    body: { filter: { property: urlName, url: { equals: url } }, page_size: 1 },
  });
  return (data.results || [])[0] || null;
}

// ---- Block copying ----------------------------------------------------------

const RICH_TEXT_TYPES = new Set([
  "paragraph",
  "quote",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "callout",
  "toggle",
  "code",
]);

function cleanRichText(rt) {
  return (rt || [])
    .map((t) => {
      const content = t.plain_text || t.text?.content || "";
      if (!content) return null;
      const node = {
        type: "text",
        text: { content: content.slice(0, 2000) },
      };
      if (t.text?.link?.url) node.text.link = { url: t.text.link.url };
      if (t.annotations) node.annotations = t.annotations;
      return node;
    })
    .filter(Boolean);
}

// Convert an API block into a creatable block, or null if unsupported.
function sanitizeBlock(block) {
  const type = block.type;
  if (type === "divider") return { object: "block", type, divider: {} };
  if (type === "bookmark") {
    const url = block.bookmark?.url;
    return url ? { object: "block", type, bookmark: { url } } : null;
  }
  if (type === "image") {
    const url = block.image?.external?.url || block.image?.file?.url;
    if (!url) return null;
    return { object: "block", type, image: { type: "external", external: { url } } };
  }
  if (RICH_TEXT_TYPES.has(type)) {
    const src = block[type] || {};
    const payload = { rich_text: cleanRichText(src.rich_text) };
    if (!payload.rich_text.length && type !== "to_do") return null;
    if (type === "code") payload.language = src.language || "plain text";
    if (type === "to_do") payload.checked = !!src.checked;
    if (src.color) payload.color = src.color;
    return { object: "block", type, [type]: payload };
  }
  return null;
}

async function copyBody(sourcePageId, targetPageId) {
  const blocks = await listAllBlocks(sourcePageId);
  const creatable = [];
  let skipped = 0;
  for (const b of blocks) {
    const c = sanitizeBlock(b);
    if (c) creatable.push(c);
    else skipped++;
  }
  for (let i = 0; i < creatable.length; i += 100) {
    await notionFetch(`/blocks/${targetPageId}/children`, {
      method: "PATCH",
      body: { children: creatable.slice(i, i + 100) },
    });
  }
  return { copied: creatable.length, skipped };
}

// ---- Main -------------------------------------------------------------------

export { getSchema, parseRow, mapStatus, buildProperties, sanitizeBlock, main };

async function main() {
  console.log(`\nMigrating entries…`);
  console.log(`  source : ${SOURCE_DB}`);
  console.log(`  target : ${TARGET_DB}`);
  if (DRY_RUN) console.log(`  (DRY RUN — nothing will be written)`);

  const target = await getSchema(TARGET_DB);
  const source = await getSchema(SOURCE_DB);
  console.log(`\nTarget database: "${target.dbTitle}"`);
  console.log(
    `  status: ${target.statusName || "—"} (${target.statusType || "n/a"}) options: ${target.statusOptions.join(", ") || "—"}`
  );
  if (!target.titleName || !target.urlName)
    die("Target database must have a title property and a URL property.");

  const rows = (await listAllRows(SOURCE_DB)).map(parseRow);
  console.log(`\nFound ${rows.length} row(s) in the source database.\n`);

  let created = 0;
  let skippedDup = 0;
  let failed = 0;

  for (const row of rows) {
    const label = row.title || row.url || row.id;
    try {
      if (!NO_DEDUPE && row.url) {
        const dup = await findByUrl(TARGET_DB, row.url, target.urlName);
        if (dup) {
          console.log(`  ↷ skip (already present): ${label}`);
          skippedDup++;
          continue;
        }
      }
      if (DRY_RUN) {
        const { status, archive } = mapStatus(row.status, target);
        console.log(
          `  + would create: ${label}  [status ${row.status || "—"} → ${status || "—"}${archive ? ", archive" : ""}]`
        );
        created++;
        continue;
      }

      const properties = buildProperties(target, row);
      const pageBody = { parent: { database_id: TARGET_DB }, properties };
      if (row.image && /^https?:\/\//i.test(row.image))
        pageBody.cover = { type: "external", external: { url: row.image } };

      const page = await notionFetch(`/pages`, { method: "POST", body: pageBody });

      let bodyNote = "";
      if (!NO_BODY) {
        const { copied, skipped } = await copyBody(row.id, page.id);
        bodyNote = ` (+${copied} block${copied === 1 ? "" : "s"}${skipped ? `, ${skipped} skipped` : ""})`;
      }
      console.log(`  ✓ ${label}${bodyNote}`);
      created++;
    } catch (e) {
      console.log(`  ✖ ${label} — ${e.message}`);
      failed++;
    }
  }

  console.log(
    `\nDone. created=${created} skipped(duplicate)=${skippedDup} failed=${failed}\n`
  );
}

import { pathToFileURL } from "node:url";
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => die(e.message));
