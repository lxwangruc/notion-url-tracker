// notion.js — Notion API client. All calls go directly to api.notion.com using
// the active profile's internal-integration token.

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export const STATUS_OPTIONS = ["Unread", "Read", "Archived", "Trash"];

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

// ---- Pages / database setup -------------------------------------------------

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
        Tags: { multi_select: {} },
        Status: {
          select: {
            options: [
              { name: "Unread", color: "yellow" },
              { name: "Read", color: "green" },
              { name: "Archived", color: "gray" },
              { name: "Trash", color: "red" },
            ],
          },
        },
        Site: { rich_text: {} },
        Author: { rich_text: {} },
        Published: { date: {} },
        Saved: { date: {} },
      },
    },
  });
}

export async function getDatabaseTags(token, databaseId) {
  const data = await notionFetch(token, `/databases/${databaseId}`);
  const tagProp = data.properties && data.properties.Tags;
  if (tagProp && tagProp.multi_select) {
    return tagProp.multi_select.options.map((o) => o.name);
  }
  return [];
}

// ---- Entries ----------------------------------------------------------------

// Return the existing entry for a URL (parsed), or null.
export async function findByUrl(token, databaseId, url) {
  const data = await notionFetch(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body: { filter: { property: "URL", url: { equals: url } }, page_size: 1 },
  });
  const hit = (data.results || [])[0];
  return hit ? parseEntry(hit) : null;
}

// Most recent N entries.
export async function queryRecent(token, databaseId, n = 10) {
  const data = await notionFetch(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body: {
      sorts: [{ property: "Saved", direction: "descending" }],
      page_size: n,
    },
  });
  return (data.results || []).map(parseEntry);
}

// Create a new entry. `entry` fields: title, url, tags[], status, site, author,
// publishedTime, image, selection, paragraphs[], bodyFormat.
export async function createEntry(token, databaseId, entry) {
  const {
    title,
    url,
    tags = [],
    status = "Unread",
    site = "",
    author = "",
    publishedTime = "",
    image = "",
    selection = "",
    paragraphs = [],
    bodyFormat = "paragraphs",
  } = entry;

  const properties = {
    Name: { title: [textNode(title || url)] },
    URL: { url },
    Tags: { multi_select: tags.map((name) => ({ name })) },
    Status: { select: { name: status } },
    Site: { rich_text: site ? [textNode(site)] : [] },
    Author: { rich_text: author ? [textNode(author)] : [] },
    Saved: { date: { start: new Date().toISOString() } },
  };
  const pub = toIsoDate(publishedTime);
  if (pub) properties.Published = { date: { start: pub } };

  const blocks = buildBodyBlocks({ selection, paragraphs, url, bodyFormat });

  const pageBody = {
    parent: { database_id: databaseId },
    properties,
    children: blocks.slice(0, 100),
  };
  const cover = externalCover(image);
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

// Update an existing entry's tags / status (and optionally append a quote).
export async function updateEntry(token, pageId, { tags, status } = {}) {
  const properties = {};
  if (Array.isArray(tags))
    properties.Tags = { multi_select: tags.map((name) => ({ name })) };
  if (status) properties.Status = { select: { name: status } };
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

// ---- Helpers ----------------------------------------------------------------

function clamp(str, max = 2000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}

function textNode(content) {
  return { type: "text", text: { content: clamp(content) } };
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

function parseEntry(page) {
  const props = page.properties || {};
  const tags =
    props.Tags && props.Tags.multi_select
      ? props.Tags.multi_select.map((o) => o.name)
      : [];
  const status =
    props.Status && props.Status.select ? props.Status.select.name : "Unread";
  const url = props.URL && props.URL.url ? props.URL.url : page.url;
  return { id: page.id, pageUrl: page.url, url, title: pageTitle(page), tags, status };
}

function toIsoDate(value) {
  if (!value) return "";
  const t = Date.parse(value);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

function externalCover(image) {
  if (image && /^https?:\/\//i.test(image)) {
    return { type: "external", external: { url: image } };
  }
  return null;
}

// Build the page body depending on the chosen format. A captured selection is
// always added first as a quote, followed by a divider.
function buildBodyBlocks({ selection, paragraphs, url, bodyFormat }) {
  const blocks = [];

  if (selection && selection.trim()) {
    for (const chunk of chunk2000(selection.trim())) {
      blocks.push(quoteBlock(chunk));
    }
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
