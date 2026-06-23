// store.js — config persistence with multi-profile support (schema v2).
// A "profile" is one Notion target: { id, name, token, databaseId, predefinedTags }.
// Global settings: { bodyFormat, savedIndicator }.

const DEFAULT_SETTINGS = { bodyFormat: "paragraphs", savedIndicator: true };

function uid() {
  return "p_" + Math.random().toString(36).slice(2, 9);
}

function emptyProfile(name = "Default") {
  return { id: uid(), name, token: "", databaseId: "", predefinedTags: [] };
}

function normalize(store) {
  const profiles =
    Array.isArray(store.profiles) && store.profiles.length
      ? store.profiles
      : [emptyProfile()];
  let activeProfileId = store.activeProfileId;
  if (!profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId = profiles[0].id;
  }
  const settings = { ...DEFAULT_SETTINGS, ...(store.settings || {}) };
  return { schemaVersion: 2, profiles, activeProfileId, settings };
}

// Read the whole store, migrating legacy (v1) config on the fly.
export async function getStore() {
  const raw = await chrome.storage.local.get(null);
  if (raw.schemaVersion === 2 && Array.isArray(raw.profiles)) {
    return normalize(raw);
  }
  // Migrate v1 { token, databaseId, predefinedTags } -> a single profile.
  const profile = emptyProfile("Default");
  profile.token = raw.token || "";
  profile.databaseId = raw.databaseId || "";
  profile.predefinedTags = raw.predefinedTags || [];
  const store = normalize({
    profiles: [profile],
    activeProfileId: profile.id,
    settings: DEFAULT_SETTINGS,
  });
  await chrome.storage.local.set(store);
  // Drop stale legacy keys.
  await chrome.storage.local.remove(["token", "databaseId", "predefinedTags"]);
  return store;
}

export async function saveStore(store) {
  await chrome.storage.local.set(normalize(store));
}

export async function getActiveProfile() {
  const s = await getStore();
  return s.profiles.find((p) => p.id === s.activeProfileId) || s.profiles[0];
}

export async function setActiveProfile(id) {
  const s = await getStore();
  if (s.profiles.some((p) => p.id === id)) {
    s.activeProfileId = id;
    await saveStore(s);
  }
}

export async function getSettings() {
  const s = await getStore();
  return s.settings;
}

export async function updateSettings(patch) {
  const s = await getStore();
  s.settings = { ...s.settings, ...patch };
  await saveStore(s);
  return s.settings;
}

// ---- Profile CRUD (used by the options page) -------------------------------

export async function addProfile(name = "New profile") {
  const s = await getStore();
  const p = emptyProfile(name);
  s.profiles.push(p);
  s.activeProfileId = p.id;
  await saveStore(s);
  return p;
}

export async function updateProfile(id, patch) {
  const s = await getStore();
  const p = s.profiles.find((x) => x.id === id);
  if (p) Object.assign(p, patch);
  await saveStore(s);
  return p;
}

export async function removeProfile(id) {
  const s = await getStore();
  if (s.profiles.length <= 1) return s; // keep at least one
  s.profiles = s.profiles.filter((p) => p.id !== id);
  if (s.activeProfileId === id) s.activeProfileId = s.profiles[0].id;
  await saveStore(s);
  return s;
}

export function profileIsReady(p) {
  return !!(p && p.token && p.databaseId);
}
