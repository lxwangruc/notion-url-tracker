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

// ---- Tags -------------------------------------------------------------------

const selectedTags = new Set();

function renderChips() {
  const wrap = document.getElementById("tag-chips");
  wrap.innerHTML = "";
  for (const tag of selectedTags) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = tag;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "chip-x";
    x.textContent = "×";
    x.onclick = () => {
      selectedTags.delete(tag);
      renderChips();
    };
    chip.appendChild(x);
    wrap.appendChild(chip);
  }
}
function addTag(raw) {
  const t = (raw || "").trim();
  if (t) selectedTags.add(t);
  renderChips();
}
function setupTagInput(suggestions) {
  const datalist = document.getElementById("tag-suggestions");
  datalist.innerHTML = "";
  for (const s of suggestions) {
    const opt = document.createElement("option");
    opt.value = s;
    datalist.appendChild(opt);
  }
  const input = document.getElementById("tag-input");
  input.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input.value);
      input.value = "";
    }
  };
  input.oninput = () => {
    if (suggestions.includes(input.value)) {
      addTag(input.value);
      input.value = "";
    }
  };
}

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
  const opts = statusList();
  for (const s of opts) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (s === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

function showFlags() {
  const fav = state.schema && state.schema.favouriteName;
  const arch = state.schema && state.schema.archiveName;
  document.getElementById("fav-wrap").classList.toggle("hidden", !fav);
  document.getElementById("arch-wrap").classList.toggle("hidden", !arch);
  document
    .getElementById("flags")
    .classList.toggle("hidden", !fav && !arch);
}

// ---- State ------------------------------------------------------------------

const state = {
  tab: null,
  profile: null,
  settings: null,
  schema: null,
  article: null,
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
    selectedTags.clear();
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
  const [existing, article, schema] = await Promise.all([
    isWeb ? findByUrl(token, databaseId, tab.url) : Promise.resolve(null),
    isWeb ? extractArticle(tab.id) : Promise.resolve(null),
    getSchema(token, databaseId),
  ]).catch((e) => {
    showError(e.message || "Failed to reach Notion.");
    return ["__err__", null, null];
  });

  if (existing === "__err__") {
    show("form");
    return;
  }
  state.schema = schema;

  state.article = article || {
    title: (tab && tab.title) || (tab && tab.url) || "",
    siteName: isWeb ? new URL(tab.url).hostname : "",
    selection: "",
    paragraphs: [],
  };

  const suggestions = Array.from(
    new Set([
      ...(state.profile.predefinedTags || []),
      ...((schema && schema.tagOptions) || []),
    ])
  ).sort((a, b) => a.localeCompare(b));
  setupTagInput(suggestions);
  showFlags();

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
  document.getElementById("favourite").checked = false;
  document.getElementById("archive").checked = false;
  selectedTags.clear();
  renderChips();
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
  document.getElementById("favourite").checked = !!existing.favourite;
  document.getElementById("archive").checked = !!existing.archive;
  selectedTags.clear();
  (existing.tags || []).forEach((t) => selectedTags.add(t));
  renderChips();
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
  if (state.tab) {
    chrome.action.setBadgeText({ text: "✓", tabId: state.tab.id });
    chrome.action.setBadgeBackgroundColor({
      color: "#16a34a",
      tabId: state.tab.id,
    });
  }
}

async function save() {
  showError("");
  const btn = document.getElementById("save");
  btn.disabled = true;
  document.getElementById("save-state").textContent =
    state.mode === "edit" ? "Updating…" : "Saving to Notion…";

  const input = document.getElementById("tag-input");
  if (input.value.trim()) {
    addTag(input.value);
    input.value = "";
  }
  const tags = Array.from(selectedTags);
  const status = document.getElementById("status").value;
  const favourite = document.getElementById("favourite").checked;
  const archive = document.getElementById("archive").checked;
  const note = document.getElementById("note").value;
  const { token, databaseId } = state.profile;

  try {
    let pageUrl;
    if (state.mode === "edit") {
      await updateEntry(
        token,
        state.editingId,
        { tags, status, favourite, archive },
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
          tags,
          status,
          favourite,
          archive,
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
