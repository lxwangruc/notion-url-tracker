// notion.js — schema-aware Notion API client. It reads the target database's
// schema and only writes properties that actually exist, so it works both with
// the extension's own auto-created database and with the "Link Tracker" template
// (Status as a status-type property, Tags multi-select, Favourite/Archive
// checkboxes, etc.).

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Fallback status list for freshly auto-created databases.
export const DEFAULT_STATUS_OPTIONS = ["Inbox", "To review", "Reviewed"];

// ---- Low-level fetch --------------------------------------------------------

async function notionFetch(token, path, { method = "GET", body } = {}) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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
    err.body = data;
    throw err;
  }
  return data;
}

// ---- Search / setup ---------------------------------------------------------

export async function searchPages(token, query = "") {
  const data = await notionFetch(token, "/search", {
    method: "POST",
    body: {
      query,
      filter: { value: "page", property: "object" },
      page_size: 50,
    },
  });
  return (data.results || []).map((p) => ({
    id: p.id,
    title: pageTitle(p),
    url: p.url,
  }));
}

export async function searchDatabases(token, query = "") {
  const data = await notionFetch(token, "/search", {
    method: "POST",
    body: {
      query,
      filter: { value: "database", property: "object" },
      page_size: 50,
    },
  });
  return (data.results || []).map((db) => ({
    id: db.id,
    title: plainTitle(db.title),
    url: db.url,
  }));
}

// Create a template-like database (Status is a select here, since the API
// cannot create status-type properties).
export async function createDatabase(token, parentPageId, title = "Read Later") {
  return notionFetch(token, "/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parentPageId },
      is_inline: true,
      title: [{ type: "text", text: { content: title } }],
      properties: {
        Name: { title: {} },
        URL: { url: {} },
        Status: {
          select: {
            options: [
              { name: "Inbox", color: "gray" },
              { name: "To review", color: "blue" },
              { name: "Reviewed", color: "green" },
            ],
          },
        },
        Type: {
          select: {
            options: [
              { name: "Video" },
              { name: "Post" },
              { name: "Book" },
              { name: "Article" },
              { name: "Podcast" },
              { name: "Product" },
              { name: "Website" },
              { name: "Template" },
            ],
          },
        },
        Tags: { multi_select: {} },
        Favourite: { checkbox: {} },
        Archive: { checkbox: {} },
        Site: { rich_text: {} },
        Saved: { date: {} },
      },
    },
  });
}

// Add a Tags multi-select to a database if it doesn't have one (used when
// pointing at the template, which has no Tags property by default).
export async function ensureTagsProperty(token, databaseId) {
  const db = await notionFetch(token, `/databases/${databaseId}`);
  const props = db.properties || {};
  // If tags are handled by a relation (the template's renamed "Tags"/"Category"
  // relation), don't add a multi-select — it would clobber that property.
  const hasRelation = Object.values(props).some((p) => p.type === "relation");
  if (hasRelation) return false;
  // A property named "Tags" already exists (any type) — leave it alone.
  if (props.Tags) return false;
  await notionFetch(token, `/databases/${databaseId}`, {
    method: "PATCH",
    body: { properties: { Tags: { multi_select: {} } } },
  });
  return true;
}

// Read and summarise the schema we care about.
export async function getSchema(token, databaseId) {
  const db = await notionFetch(token, `/databases/${databaseId}`);
  const props = db.properties || {};
  const byName = {};
  const schema = {
    byName,
    titleName: null,
    urlName: null,
    statusName: null,
    statusType: null,
    statusOptions: [],
    tagsName: null,
    tagOptions: [],
    typeName: null,
    typeOptions: [],
    favouriteName: null,
    archiveName: null,
    siteName: null,
    authorName: null,
    publishedName: null,
    savedName: null,
    tagRelName: null,
    tagRelDbId: null,
    sortName: null,
    dbTitle: plainTitle(db.title),
    missing: [],
  };

  for (const [name, prop] of Object.entries(props)) {
    byName[name] = prop.type;
    switch (prop.type) {
      case "title":
        schema.titleName = name;
        break;
      case "url":
        if (!schema.urlName) schema.urlName = name;
        break;
      case "status":
        if (name === "Status" || !schema.statusName) {
          schema.statusName = name;
          schema.statusType = "status";
          schema.statusOptions = (prop.status.options || []).map((o) => o.name);
        }
        break;
      case "select":
        if (name === "Status") {
          schema.statusName = name;
          schema.statusType = "select";
          schema.statusOptions = (prop.select.options || []).map((o) => o.name);
        } else if (name === "Type") {
          schema.typeName = name;
          schema.typeOptions = (prop.select.options || []).map((o) => o.name);
        }
        break;
      case "multi_select":
        if (name === "Tags" || !schema.tagsName) {
          schema.tagsName = name;
          schema.tagOptions = (prop.multi_select.options || []).map(
            (o) => o.name
          );
        }
        break;
      case "checkbox":
        if (/^favou?rite$/i.test(name)) schema.favouriteName = name;
        else if (/^archive$/i.test(name)) schema.archiveName = name;
        break;
      case "rich_text":
        if (name === "Site") schema.siteName = name;
        else if (name === "Author") schema.authorName = name;
        break;
      case "date":
        if (name === "Published") schema.publishedName = name;
        else if (name === "Saved") schema.savedName = name;
        break;
      case "relation":
        // The relation is treated as "Tags" (reusable rows in a linked DB).
        // Prefer a relation named like Tag/Category; otherwise take the first.
        if (
          /^tags?$/i.test(name) ||
          /^categor/i.test(name) ||
          !schema.tagRelName
        ) {
          schema.tagRelName = name;
          schema.tagRelDbId =
            (prop.relation && prop.relation.database_id) || null;
        }
        break;
      default:
        break;
    }
  }

  // Sort preference for the "recent" list.
  if (schema.savedName) schema.sortName = schema.savedName;
  else {
    for (const [name, type] of Object.entries(byName)) {
      if (type === "created_time") {
        schema.sortName = name;
        break;
      }
    }
    if (!schema.sortName) {
      for (const [name, type] of Object.entries(byName)) {
        if (type === "last_edited_time") {
          schema.sortName = name;
          break;
        }
      }
    }
  }

  if (!schema.titleName) schema.missing.push("a title property");
  if (!schema.urlName) schema.missing.push("a URL property");
  return schema;
}

// ---- Entries ----------------------------------------------------------------

export async function findByUrl(token, databaseId, url, urlName = "URL") {
  const data = await notionFetch(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body: { filter: { property: urlName, url: { equals: url } }, page_size: 1 },
  });
  const hit = (data.results || [])[0];
  return hit ? parseEntry(hit) : null;
}

export async function queryRecent(token, databaseId, n = 10, sortName = null) {
  const body = { page_size: n };
  if (sortName) body.sorts = [{ property: sortName, direction: "descending" }];
  const data = await notionFetch(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body,
  });
  return (data.results || []).map(parseEntry);
}

// ---- Tags (relation target database) ----------------------------------------

// Load the related "Tags" database: returns its title property name and the
// list of existing rows as { id, name }.
export async function loadTagRows(token, databaseId) {
  const db = await notionFetch(token, `/databases/${databaseId}`);
  let titleName = "Name";
  for (const [name, prop] of Object.entries(db.properties || {})) {
    if (prop.type === "title") {
      titleName = name;
      break;
    }
  }
  const options = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(token, `/databases/${databaseId}/query`, {
      method: "POST",
      body,
    });
    for (const pg of data.results || [])
      options.push({ id: pg.id, name: pageTitle(pg) });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  options.sort((a, b) => a.name.localeCompare(b.name));
  return { titleName, options };
}

// Create a new tag row and return { id, name }.
export async function createTagRow(token, databaseId, titleName, name) {
  const page = await notionFetch(token, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: databaseId },
      properties: { [titleName || "Name"]: { title: [textNode(name)] } },
    },
  });
  return { id: page.id, name };
}

// Create a new entry. `data` may include: title, url, tags[], status, favourite,
// archive, type, site, author, publishedTime, image, selection, paragraphs[],
// bodyFormat. Only fields that exist in the schema are written.
export async function createEntry(token, databaseId, data, schema = null) {
  schema = schema || (await getSchema(token, databaseId));

  const full = { ...data };
  if (full.saved === undefined) full.saved = new Date().toISOString();
  const properties = buildProperties(schema, full);

  const blocks = buildBodyBlocks({
    selection: data.selection,
    paragraphs: data.paragraphs || [],
    url: data.url,
    bodyFormat: data.bodyFormat || "paragraphs",
  });

  const pageBody = {
    parent: { database_id: databaseId },
    properties,
    children: blocks.slice(0, 100),
  };
  const cover = externalCover(data.image);
  if (cover) pageBody.cover = cover;

  const page = await notionFetch(token, "/pages", {
    method: "POST",
    body: pageBody,
  });

  for (let i = 100; i < blocks.length; i += 100) {
    await appendBlocks(token, page.id, blocks.slice(i, i + 100));
  }
  return page;
}

// Update an existing entry. `data` may include tags, status, favourite, archive.
export async function updateEntry(token, pageId, data, schema) {
  const properties = buildProperties(schema, data);
  return notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: { properties },
  });
}

export async function appendBlocks(token, pageId, blocks) {
  if (!blocks.length) return;
  return notionFetch(token, `/blocks/${pageId}/children`, {
    method: "PATCH",
    body: { children: blocks },
  });
}

// ---- Property building ------------------------------------------------------

function buildProperties(schema, data) {
  const p = {};
  if (data.title !== undefined && schema.titleName)
    p[schema.titleName] = { title: [textNode(data.title || data.url || "")] };
  if (data.url !== undefined && schema.urlName)
    p[schema.urlName] = { url: data.url };
  if (data.tags !== undefined && schema.tagsName)
    p[schema.tagsName] = { multi_select: (data.tags || []).map((name) => ({ name })) };
  if (data.status !== undefined && schema.statusName && data.status) {
    p[schema.statusName] =
      schema.statusType === "status"
        ? { status: { name: data.status } }
        : { select: { name: data.status } };
  }
  if (data.favourite !== undefined && schema.favouriteName)
    p[schema.favouriteName] = { checkbox: !!data.favourite };
  if (data.archive !== undefined && schema.archiveName)
    p[schema.archiveName] = { checkbox: !!data.archive };
  if (data.type !== undefined && schema.typeName)
    p[schema.typeName] = { select: data.type ? { name: data.type } : null };
  if (data.site !== undefined && schema.siteName)
    p[schema.siteName] = { rich_text: data.site ? [textNode(data.site)] : [] };
  if (data.author !== undefined && schema.authorName)
    p[schema.authorName] = { rich_text: data.author ? [textNode(data.author)] : [] };
  if (data.publishedTime !== undefined && schema.publishedName) {
    const iso = toIsoDate(data.publishedTime);
    if (iso) p[schema.publishedName] = { date: { start: iso } };
  }
  if (data.saved !== undefined && schema.savedName)
    p[schema.savedName] = { date: { start: data.saved } };
  if (data.tagRefs !== undefined && schema.tagRelName)
    p[schema.tagRelName] = {
      relation: (data.tagRefs || []).map((id) => ({ id })),
    };
  return p;
}

// ---- Parsing ----------------------------------------------------------------

function parseEntry(page) {
  const props = page.properties || {};
  let title = "";
  let url = page.url;
  let tags = [];
  let status = "";
  let favourite = false;
  let archive = false;
  let tagRefs = [];
  let type = "";
  for (const [name, prop] of Object.entries(props)) {
    switch (prop.type) {
      case "title":
        title = prop.title.map((t) => t.plain_text).join("") || title;
        break;
      case "url":
        if (prop.url) url = prop.url;
        break;
      case "multi_select":
        if (name === "Tags") tags = prop.multi_select.map((o) => o.name);
        break;
      case "status":
        if (prop.status) status = prop.status.name;
        break;
      case "select":
        if (name === "Status" && prop.select) status = prop.select.name;
        else if (name === "Type" && prop.select) type = prop.select.name;
        break;
      case "checkbox":
        if (/^favou?rite$/i.test(name)) favourite = prop.checkbox;
        else if (/^archive$/i.test(name)) archive = prop.checkbox;
        break;
      case "relation":
        if (/^tags?$/i.test(name) || /^categor/i.test(name) || !tagRefs.length)
          tagRefs = (prop.relation || []).map((r) => r.id);
        break;
      default:
        break;
    }
  }
  return {
    id: page.id,
    pageUrl: page.url,
    url,
    title: title || url,
    tags,
    status,
    favourite,
    archive,
    tagRefs,
    type,
  };
}

function pageTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text).join("");
      if (text) return text;
    }
  }
  return page.url || "(untitled)";
}

function plainTitle(titleArray) {
  if (!Array.isArray(titleArray)) return "(untitled database)";
  const t = titleArray.map((x) => x.plain_text || "").join("");
  return t || "(untitled database)";
}

// ---- Blocks / helpers -------------------------------------------------------

function clamp(str, max = 2000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}
function textNode(content) {
  return { type: "text", text: { content: clamp(content) } };
}
function toIsoDate(value) {
  if (!value) return "";
  const t = Date.parse(value);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}
function externalCover(image) {
  if (image && /^https?:\/\//i.test(image))
    return { type: "external", external: { url: image } };
  return null;
}

function buildBodyBlocks({ selection, paragraphs, url, bodyFormat }) {
  const blocks = [];
  if (selection && selection.trim()) {
    for (const chunk of chunk2000(selection.trim())) blocks.push(quoteBlock(chunk));
    blocks.push({ object: "block", type: "divider", divider: {} });
  }
  if (bodyFormat === "bookmark") {
    blocks.push({ object: "block", type: "bookmark", bookmark: { url } });
    return blocks;
  }
  const make = bodyFormat === "quote" ? quoteBlock : paragraphBlock;
  for (const para of paragraphs) {
    const text = (para || "").trim();
    if (!text) continue;
    for (const chunk of chunk2000(text)) blocks.push(make(chunk));
  }
  return blocks;
}
function chunk2000(text) {
  const MAX = 1900;
  const out = [];
  for (let i = 0; i < text.length; i += MAX) out.push(text.slice(i, i + MAX));
  return out;
}
function paragraphBlock(content) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  };
}
function quoteBlock(content) {
  return {
    object: "block",
    type: "quote",
    quote: { rich_text: [{ type: "text", text: { content } }] },
  };
}
