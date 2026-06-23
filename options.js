import {
  getStore,
  getActiveProfile,
  setActiveProfile,
  addProfile,
  updateProfile,
  removeProfile,
  getSettings,
  updateSettings,
} from "./store.js";
import { searchPages, searchDatabases, createDatabase, ensureTagsProperty, getSchema } from "./notion.js";

function setStatus(id, message, kind = "") {
  const el = document.getElementById(id);
  el.textContent = message;
  el.className = "status " + kind;
}
function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

let current = null; // active profile being edited

async function refreshProfileSelect() {
  const store = await getStore();
  const sel = document.getElementById("profile-select");
  sel.innerHTML = "";
  for (const p of store.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === store.activeProfileId) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadProfileIntoForm() {
  current = await getActiveProfile();
  document.getElementById("profile-name").value = current.name;
  document.getElementById("token").value = current.token || "";
  document.getElementById("db-id").value = current.databaseId || "";
  document.getElementById("tags").value = (current.predefinedTags || []).join(
    "\n"
  );
  document.getElementById("current-db").textContent = current.databaseId
    ? "Current database: " + current.databaseId
    : "No database set for this profile yet.";
  setStatus("token-status", current.token ? "Token set" : "", current.token ? "ok" : "");
  setStatus("db-status", "");
  if (current.token) {
    await loadPages();
    await loadDatabases();
  } else {
    document.getElementById("parent-page").innerHTML =
      '<option value="">— select a parent page —</option>';
    document.getElementById("db-select").innerHTML =
      '<option value="">— select an existing database —</option>';
  }
}

async function loadDatabases() {
  if (!current.token) return;
  const select = document.getElementById("db-select");
  try {
    const dbs = await searchDatabases(current.token);
    select.innerHTML =
      '<option value="">— select an existing database —</option>';
    for (const db of dbs) {
      const opt = document.createElement("option");
      opt.value = db.id;
      opt.textContent = db.title;
      if (db.id === current.databaseId) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (e) {
    showError(e.message || "Could not list databases.");
  }
}

// Point the profile at a database: ensure a Tags property and validate schema.
async function applyDatabase(id) {
  setStatus("db-status", "Checking database…");
  try {
    const added = await ensureTagsProperty(current.token, id);
    const schema = await getSchema(current.token, id);
    await updateProfile(current.id, { databaseId: id });
    current.databaseId = id;
    document.getElementById("db-id").value = id;
    document.getElementById("current-db").textContent =
      "Current database: " + (schema.dbTitle || id);
    let msg = "Database set ✓";
    if (added) msg += " (added Tags property)";
    if (schema.missing.length) {
      showError(
        "Warning: this database is missing " +
          schema.missing.join(" and ") +
          ". Saving may fail until you add it."
      );
    } else {
      showError("");
    }
    setStatus("db-status", msg, "ok");
    await loadDatabases();
  } catch (e) {
    setStatus("db-status", "");
    showError(e.message || "Could not use this database.");
  }
}

async function loadPages() {
  if (!current.token) return;
  const select = document.getElementById("parent-page");
  setStatus("db-status", "Loading pages…");
  try {
    const pages = await searchPages(current.token);
    select.innerHTML = '<option value="">— select a parent page —</option>';
    for (const p of pages) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.title;
      select.appendChild(opt);
    }
    setStatus(
      "db-status",
      pages.length
        ? `${pages.length} page(s) available`
        : "No pages shared with the integration yet."
    );
  } catch (e) {
    setStatus("db-status", "");
    showError(e.message || "Could not list pages.");
  }
}

// ---- Settings ---------------------------------------------------------------

async function loadSettings() {
  const s = await getSettings();
  document.getElementById("body-format").value = s.bodyFormat;
  document.getElementById("saved-indicator").checked = !!s.savedIndicator;
}

// ---- Init -------------------------------------------------------------------

async function init() {
  await refreshProfileSelect();
  await loadProfileIntoForm();
  await loadSettings();
}

// Profile switching / CRUD
document.getElementById("profile-select").onchange = async (e) => {
  showError("");
  await setActiveProfile(e.target.value);
  await loadProfileIntoForm();
};
document.getElementById("add-profile").onclick = async () => {
  showError("");
  await addProfile("New profile");
  await refreshProfileSelect();
  await loadProfileIntoForm();
};
document.getElementById("delete-profile").onclick = async () => {
  showError("");
  const store = await getStore();
  if (store.profiles.length <= 1) {
    showError("You must keep at least one profile.");
    return;
  }
  if (!confirm(`Delete profile "${current.name}"?`)) return;
  await removeProfile(current.id);
  await refreshProfileSelect();
  await loadProfileIntoForm();
};
document.getElementById("profile-name").onchange = async (e) => {
  const name = e.target.value.trim() || "Untitled";
  await updateProfile(current.id, { name });
  current.name = name;
  await refreshProfileSelect();
};

// Token
document.getElementById("save-token").onclick = async () => {
  showError("");
  const token = document.getElementById("token").value.trim();
  if (!token) return setStatus("token-status", "Enter a token first", "err");
  await updateProfile(current.id, { token });
  current.token = token;
  setStatus("token-status", "Saved. Loading pages…", "ok");
  await loadPages();
  await loadDatabases();
};

document.getElementById("refresh-pages").onclick = loadPages;
document.getElementById("refresh-dbs").onclick = loadDatabases;

// Database
document.getElementById("use-db").onclick = async () => {
  showError("");
  const id = document.getElementById("db-select").value;
  if (!current.token) return setStatus("db-status", "Save a token first", "err");
  if (!id) return setStatus("db-status", "Pick a database", "err");
  await applyDatabase(id);
};
document.getElementById("create-db").onclick = async () => {
  showError("");
  const parentId = document.getElementById("parent-page").value;
  if (!current.token) return setStatus("db-status", "Save a token first", "err");
  if (!parentId) return setStatus("db-status", "Pick a parent page", "err");
  setStatus("db-status", "Creating database…");
  try {
    const db = await createDatabase(current.token, parentId, "Read Later");
    await updateProfile(current.id, { databaseId: db.id });
    current.databaseId = db.id;
    document.getElementById("db-id").value = db.id;
    document.getElementById("current-db").textContent =
      "Current database: " + db.id;
    setStatus("db-status", "Database created ✓", "ok");
    await loadDatabases();
  } catch (e) {
    setStatus("db-status", "");
    showError(e.message || "Could not create database.");
  }
};
document.getElementById("save-db-id").onclick = async () => {
  showError("");
  const id = document.getElementById("db-id").value.trim();
  if (!id) return;
  await applyDatabase(id);
};

// Tags
document.getElementById("save-tags").onclick = async () => {
  const raw = document.getElementById("tags").value;
  const tags = Array.from(
    new Set(
      raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
  await updateProfile(current.id, { predefinedTags: tags });
  current.predefinedTags = tags;
  setStatus("tags-status", `Saved ${tags.length} tag(s) ✓`, "ok");
};

// Settings
document.getElementById("save-settings").onclick = async () => {
  await updateSettings({
    bodyFormat: document.getElementById("body-format").value,
    savedIndicator: document.getElementById("saved-indicator").checked,
  });
  setStatus("settings-status", "Settings saved ✓", "ok");
};

init();
