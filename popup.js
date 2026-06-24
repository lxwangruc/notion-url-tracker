import {
  getStore,
  getActiveProfile,
  setActiveProfile,
  getSettings,
  profileIsReady,
} from "./store.js";
import {
  DEFAULT_STATUS_OPTIONS,
  getSchema,
  findByUrl,
  queryRecent,
  createEntry,
  updateEntry,
  appendBlocks,
  loadTagRows,
  createTagRow,
} from "./notion.js";
import { extractArticle } from "./extract.js";

// ---- View helpers -----------------------------------------------------------

const views = ["needs-setup", "loading", "form", "recent", "success"];
function show(view) {
  for (const id of views)
    document.getElementById(id).classList.toggle("hidden", id !== view);
  document
    .getElementById("topbar")
    .classList.toggle("hidden", view === "needs-setup" || view === "loading");
}
function showError(msg) {
  const el = document.getElementById("error");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

// ---- Tags (unified: relation rows OR multi-select) --------------------------
//
// In "relation" mode each tag is a row in a linked database; the chip's value is
// the row id and a new name creates a row. In "multi_select" mode the value is
// just the tag name.

const tagSel = new Map(); // value -> label
let tagByLabel = new Map(); // lowercased label -> { value, label }
let tagByValue = new Map(); // value -> label

function renderTagChips() {
  const wrap = document.getElementById("tag-chips");
  wrap.innerHTML = "";
  for (const [value, label] of tagSel) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = label;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chip-x";
    x.textContent = "×";
    x.onclick = () => {
      tagSel.delete(value);
      renderTagChips();
    };
    chip.appendChild(x);
    wrap.appendChild(chip);
  }
}

function addTagItem(value, label) {
  if (value === null || value === undefined) return;
  tagSel.set(value, label || tagByValue.get(value) || value);
  renderTagChips();
}

function indexTags(options, extraLabels) {
  tagByLabel = new Map();
  tagByValue = new Map();
  for (const o of options) {
    tagByLabel.set(o.label.toLowerCase(), o);
    tagByValue.set(o.value, o.label);
  }
  const datalist = document.getElementById("tag-suggestions");
  datalist.innerHTML = "";
  const labels = new Set([
    ...options.map((o) => o.label),
    ...(extraLabels || []),
  ]);
  for (const l of [...labels].sort((a, b) => a.localeCompare(b))) {
    const opt = document.createElement("option");
    opt.value = l;
    datalist.appendChild(opt);
  }
}

function setupTagControl() {
  const input = document.getElementById("tag-input");
  const stateEl = document.getElementById("tag-state");

  async function commit() {
    const raw = input.value.trim();
    if (!raw) return;
    const hit = tagByLabel.get(raw.toLowerCase());
    if (hit) {
      addTagItem(hit.value, hit.label);
      input.value = "";
      return;
    }
    if (state.tagsMode === "relation") {
      input.disabled = true;
      stateEl.textContent = `Creating “${raw}”…`;
      try {
        const created = await createTagRow(
          state.profile.token,
          state.schema.tagRelDbId,
          state.tagTitleName,
          raw
        );
        const merged = [...tagByValue.entries()]
          .map(([value, label]) => ({ value, label }))
          .concat([{ value: created.id, label: created.name }])
          .sort((a, b) => a.label.localeCompare(b.label));
        indexTags(merged, state.profile.predefinedTags);
        addTagItem(created.id, created.name);
        input.value = "";
        stateEl.textContent = "";
      } catch (e) {
        stateEl.textContent = e.message || "Could not create tag.";
      } finally {
        input.disabled = false;
        input.focus();
      }
    } else {
      // multi-select: the value is the tag name itself
      addTagItem(raw, raw);
      input.value = "";
    }
  }

  input.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    }
  };
  input.oninput = () => {
    const hit = tagByLabel.get(input.value.trim().toLowerCase());
    if (hit) {
      addTagItem(hit.value, hit.label);
      input.value = "";
    }
  };
}

function setupTags(preselect) {
  const s = state.schema;
  if (s && s.tagRelName) state.tagsMode = "relation";
  else if (s && s.tagsName) state.tagsMode = "multi_select";
  else state.tagsMode = null;

  const field = document.getElementById("tag-field");
  field.classList.toggle("hidden", !state.tagsMode);
  tagSel.clear();
  if (!state.tagsMode) {
    renderTagChips();
    return;
  }

  let options;
  if (state.tagsMode === "relation") {
    options = (state.tagOptions || []).map((o) => ({
      value: o.id,
      label: o.name,
    }));
    indexTags(options, state.profile.predefinedTags);
  } else {
    const names = Array.from(
      new Set([
        ...(state.profile.predefinedTags || []),
        ...((s && s.tagOptions) || []),
      ])
    );
    options = names.map((n) => ({ value: n, label: n }));
    indexTags(options, []);
  }
  setupTagControl();

  for (const item of preselect || []) {
    if (state.tagsMode === "relation")
      addTagItem(item, tagByValue.get(item) || item);
    else addTagItem(item, item);
  }
  renderTagChips();
}

function selectedTagData() {
  if (state.tagsMode === "relation")
    return { tagRefs: Array.from(tagSel.keys()) };
  if (state.tagsMode === "multi_select")
    return { tags: Array.from(tagSel.keys()) };
  return {};
}

// ---- Type -------------------------------------------------------------------

function setupTypeField(selected) {
  const s = state.schema;
  const has = s && s.typeName; // show whenever the Type property exists
  document.getElementById("type-field").classList.toggle("hidden", !has);
  if (!has) return;
  const datalist = document.getElementById("type-suggestions");
  datalist.innerHTML = "";
  for (const t of s.typeOptions || []) {
    const opt = document.createElement("option");
    opt.value = t;
    datalist.appendChild(opt);
  }
  document.getElementById("type").value = selected || "";
}

// ---- Status -----------------------------------------------------------------

function statusList() {
  const opts =
    state.schema && state.schema.statusOptions.length
      ? state.schema.statusOptions
      : DEFAULT_STATUS_OPTIONS;
  return opts;
}
function fillStatusOptions(selected) {
  const sel = document.getElementById("status");
  sel.innerHTML = "";
  for (const s of statusList()) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (s === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ---- State ------------------------------------------------------------------

const state = {
  tab: null,
  profile: null,
  settings: null,
  schema: null,
  article: null,
  tagsMode: null,
  tagOptions: [],
  tagTitleName: "Name",
  mode: "new",
  editingId: null,
  editingPageUrl: null,
};

async function buildProfileSelect() {
  const store = await getStore();
  const sel = document.getElementById("profile");
  sel.innerHTML = "";
  for (const p of store.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === store.activeProfileId) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.style.display = store.profiles.length > 1 ? "" : "none";
  sel.onchange = async () => {
    await setActiveProfile(sel.value);
    state.schema = null;
    main();
  };
}

async function main() {
  showError("");
  await buildProfileSelect();
  state.profile = await getActiveProfile();
  state.settings = await getSettings();

  if (!profileIsReady(state.profile)) {
    show("needs-setup");
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  const isWeb = tab && /^https?:/i.test(tab.url || "");

  show("loading");

  const { token, databaseId } = state.profile;
  let schema;
  try {
    schema = await getSchema(token, databaseId);
  } catch (e) {
    state.schema = null;
    enterNewMode();
    show("form");
    showError(e.message || "Failed to reach Notion.");
    document.getElementById("save").disabled = true;
    return;
  }
  state.schema = schema;

  const [existing, article, tagRows] = await Promise.all([
    isWeb ? findByUrl(token, databaseId, tab.url) : Promise.resolve(null),
    isWeb ? extractArticle(tab.id) : Promise.resolve(null),
    schema.tagRelName
      ? loadTagRows(token, schema.tagRelDbId).catch(() => ({
          titleName: "Name",
          options: [],
        }))
      : Promise.resolve({ titleName: "Name", options: [] }),
  ]).catch((e) => {
    showError(e.message || "Failed to reach Notion.");
    return ["__err__", null, { titleName: "Name", options: [] }];
  });

  if (existing === "__err__") {
    show("form");
    return;
  }

  state.tagOptions = tagRows.options || [];
  state.tagTitleName = tagRows.titleName || "Name";

  state.article = article || {
    title: (tab && tab.title) || (tab && tab.url) || "",
    siteName: isWeb ? new URL(tab.url).hostname : "",
    selection: "",
    paragraphs: [],
  };

  const note = state.article.selection || "";
  document.getElementById("note-field").classList.toggle("hidden", !note);
  document.getElementById("note").value = note;

  if (!isWeb) {
    enterNewMode();
    show("form");
    showError("This page can't be read; only http/https pages are supported.");
    document.getElementById("save").disabled = true;
    return;
  }

  document.getElementById("save").disabled = false;
  if (existing) enterEditMode(existing);
  else enterNewMode();
}

function enterNewMode() {
  state.mode = "new";
  state.editingId = null;
  document.getElementById("dup-banner").classList.add("hidden");
  document.getElementById("form-title").textContent = "Save to read-later";
  const title = document.getElementById("title");
  title.value = state.article.title || (state.tab && state.tab.url) || "";
  title.disabled = false;
  fillStatusOptions(statusList()[0]); // default = first status (e.g. Inbox)
  setupTags([]);
  setupTypeField("");
  document.getElementById("save").textContent = "Save";
  show("form");
  document.getElementById("tag-input").focus();
}

function enterEditMode(existing) {
  state.mode = "edit";
  state.editingId = existing.id;
  state.editingPageUrl = existing.pageUrl;
  document.getElementById("dup-banner").classList.remove("hidden");
  document.getElementById("open-existing-inline").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: existing.pageUrl });
    window.close();
  };
  document.getElementById("form-title").textContent = "Edit saved entry";
  const title = document.getElementById("title");
  title.value = existing.title;
  title.disabled = true;
  fillStatusOptions(existing.status || statusList()[0]);
  const useRelation = !!(state.schema && state.schema.tagRelName);
  const preselect = useRelation ? existing.tagRefs : existing.tags;
  setupTags(preselect || []);
  setupTypeField(existing.type || "");
  document.getElementById("save").textContent = "Update";
  show("form");
  document.getElementById("tag-input").focus();
}

// ---- Save -------------------------------------------------------------------

function noteBlocks(text) {
  const t = (text || "").trim();
  if (!t) return [];
  const out = [];
  for (let i = 0; i < t.length; i += 1900) {
    out.push({
      object: "block",
      type: "quote",
      quote: {
        rich_text: [{ type: "text", text: { content: t.slice(i, i + 1900) } }],
      },
    });
  }
  return out;
}

function tickBadge() {
  if (!state.tab) return;
  try {
    chrome.action.setBadgeText({ text: "✓", tabId: state.tab.id });
    chrome.action.setBadgeBackgroundColor({
      color: "#16a34a",
      tabId: state.tab.id,
    });
  } catch (_) {}
}

async function save() {
  showError("");
  const btn = document.getElementById("save");
  btn.disabled = true;
  document.getElementById("save-state").textContent =
    state.mode === "edit" ? "Updating…" : "Saving to Notion…";

  const input = document.getElementById("tag-input");
  if (input.value.trim()) {
    // flush a half-typed tag (relation create may be async)
    const raw = input.value.trim();
    const hit = tagByLabel.get(raw.toLowerCase());
    if (hit) addTagItem(hit.value, hit.label);
    else if (state.tagsMode === "multi_select") addTagItem(raw, raw);
    else if (state.tagsMode === "relation") {
      try {
        const created = await createTagRow(
          state.profile.token,
          state.schema.tagRelDbId,
          state.tagTitleName,
          raw
        );
        addTagItem(created.id, created.name);
      } catch (_) {}
    }
    input.value = "";
  }

  const tagData = selectedTagData();
  const status = document.getElementById("status").value;
  const typeEl = document.getElementById("type");
  const type =
    state.schema && state.schema.typeName ? typeEl.value.trim() : undefined;
  const note = document.getElementById("note").value;
  const { token, databaseId } = state.profile;

  try {
    let pageUrl;
    if (state.mode === "edit") {
      await updateEntry(
        token,
        state.editingId,
        { ...tagData, status, type },
        state.schema
      );
      const blocks = noteBlocks(note);
      if (blocks.length) await appendBlocks(token, state.editingId, blocks);
      pageUrl = state.editingPageUrl;
    } else {
      const page = await createEntry(
        token,
        databaseId,
        {
          title: document.getElementById("title").value.trim(),
          url: state.tab.url,
          ...tagData,
          status,
          type,
          site: state.article.siteName || "",
          author: state.article.byline || "",
          publishedTime: state.article.publishedTime || "",
          image: state.article.image || "",
          selection: note,
          paragraphs: state.article.paragraphs || [],
          bodyFormat: state.settings.bodyFormat,
        },
        state.schema
      );
      pageUrl = page.url;
    }
    tickBadge();
    document.getElementById("success-title").textContent =
      state.mode === "edit" ? "Updated ✓" : "Saved ✓";
    show("success");
    document.getElementById("open-saved").onclick = () => {
      chrome.tabs.create({ url: pageUrl });
      window.close();
    };
  } catch (e) {
    btn.disabled = false;
    document.getElementById("save-state").textContent = "";
    showError(e.message || "Failed to save.");
  }
}

// ---- Recent list ------------------------------------------------------------

async function loadRecent() {
  show("recent");
  const list = document.getElementById("recent-list");
  list.innerHTML = '<div class="spinner"></div>';
  document.getElementById("recent-empty").classList.add("hidden");
  try {
    const { token, databaseId } = state.profile;
    const sortName = state.schema ? state.schema.sortName : null;
    const items = await queryRecent(token, databaseId, 10, sortName);
    list.innerHTML = "";
    if (!items.length) {
      document.getElementById("recent-empty").classList.remove("hidden");
      return;
    }
    for (const item of items) list.appendChild(recentRow(item));
  } catch (e) {
    list.innerHTML = "";
    showError(e.message || "Could not load recent entries.");
  }
}

function recentRow(item) {
  const opts = statusList();
  const unread = opts[0];
  const read = opts[opts.length - 1];

  const row = document.createElement("div");
  row.className = "recent-row";

  const main = document.createElement("button");
  main.className = "recent-title link";
  main.textContent = item.title;
  main.title = item.url;
  main.onclick = () => chrome.tabs.create({ url: item.pageUrl });

  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = item.status || "—";

  const toggle = document.createElement("button");
  toggle.className = "ghost xs";
  const label = (s) => (s === read ? `↩ ${unread}` : `✓ ${read}`);
  toggle.textContent = label(item.status);
  toggle.onclick = async () => {
    toggle.disabled = true;
    const next = item.status === read ? unread : read;
    try {
      await updateEntry(
        state.profile.token,
        item.id,
        { status: next },
        state.schema
      );
      item.status = next;
      pill.textContent = next;
      toggle.textContent = label(next);
    } catch (e) {
      showError(e.message || "Update failed.");
    } finally {
      toggle.disabled = false;
    }
  };

  const meta = document.createElement("div");
  meta.className = "recent-meta";
  meta.append(pill, toggle);
  row.append(main, meta);
  return row;
}

// ---- Wire up ----------------------------------------------------------------

document.getElementById("open-options").onclick = () =>
  chrome.runtime.openOptionsPage();
document.getElementById("save").onclick = save;
document.getElementById("cancel").onclick = () => window.close();
document.getElementById("close").onclick = () => window.close();
document.getElementById("show-recent").onclick = loadRecent;
document.getElementById("recent-back").onclick = () => {
  showError("");
  show("form");
};

main();
