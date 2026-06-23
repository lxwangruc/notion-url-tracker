// background.js — service worker (module). Handles keyboard shortcuts, the
// right-click context menu, success/saved badges, and notifications.

import {
  getActiveProfile,
  getSettings,
  profileIsReady,
} from "./store.js";
import { findByUrl, createEntry } from "./notion.js";
import { extractArticle } from "./extract.js";

const ICON = "icons/icon128.png";

// ---- UI feedback ------------------------------------------------------------

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL(ICON),
    title,
    message: message || "",
  });
}

function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ text, tabId });
    if (color) chrome.action.setBadgeBackgroundColor({ color, tabId });
  } catch (_) {}
}

// Show a transient ✓ on the tab, then fall back to the saved-indicator state.
function badgeTick(tabId) {
  setBadge(tabId, "✓", "#16a34a");
  setTimeout(() => refreshIndicator(tabId), 2500);
}

// ---- Saved indicator (dot on already-saved pages) ---------------------------

async function refreshIndicator(tabId) {
  try {
    const settings = await getSettings();
    if (!settings.savedIndicator) return setBadge(tabId, "", null);
    const profile = await getActiveProfile();
    if (!profileIsReady(profile)) return setBadge(tabId, "", null);
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !/^https?:/i.test(tab.url || "")) return setBadge(tabId, "", null);
    const existing = await findByUrl(profile.token, profile.databaseId, tab.url);
    setBadge(tabId, existing ? "•" : "", existing ? "#2563eb" : null);
  } catch (_) {
    /* rate limits / offline: ignore */
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => refreshIndicator(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) refreshIndicator(tabId);
});

// ---- Save helpers -----------------------------------------------------------

async function ready() {
  const profile = await getActiveProfile();
  if (!profileIsReady(profile)) {
    notify("Setup needed", "Open the extension settings to connect Notion.");
    return null;
  }
  return { profile, settings: await getSettings() };
}

async function savePage(tab, selectionText = "") {
  const ctx = await ready();
  if (!ctx) return;
  if (!tab || !/^https?:/i.test(tab.url || "")) {
    notify("Can't save", "Only http/https pages can be saved.");
    return;
  }
  const { profile, settings } = ctx;
  try {
    const existing = await findByUrl(profile.token, profile.databaseId, tab.url);
    if (existing) {
      setBadge(tab.id, "•", "#2563eb");
      notify("Already saved", existing.title || tab.url);
      return;
    }
    const article =
      (await extractArticle(tab.id)) || {
        title: tab.title || tab.url,
        siteName: hostOf(tab.url),
        paragraphs: [],
      };
    const page = await createEntry(profile.token, profile.databaseId, {
      title: article.title,
      url: tab.url,
      tags: [],
      status: "Unread",
      site: article.siteName,
      author: article.byline,
      publishedTime: article.publishedTime,
      image: article.image,
      selection: selectionText || article.selection || "",
      paragraphs: article.paragraphs || [],
      bodyFormat: settings.bodyFormat,
    });
    badgeTick(tab.id);
    notify("Saved to Notion ✓", article.title || tab.url);
    return page;
  } catch (e) {
    notify("Save failed", e.message || "Could not reach Notion.");
  }
}

async function saveLink(linkUrl, selectionText, tabId) {
  const ctx = await ready();
  if (!ctx) return;
  if (!/^https?:/i.test(linkUrl || "")) return;
  const { profile } = ctx;
  try {
    const existing = await findByUrl(profile.token, profile.databaseId, linkUrl);
    if (existing) {
      notify("Already saved", existing.title || linkUrl);
      return;
    }
    await createEntry(profile.token, profile.databaseId, {
      title: selectionText || linkUrl,
      url: linkUrl,
      tags: [],
      status: "Unread",
      site: hostOf(linkUrl),
      paragraphs: [],
      bodyFormat: "bookmark", // link only: store a preview, no article text
    });
    if (tabId != null) badgeTick(tabId);
    notify("Link saved to Notion ✓", selectionText || linkUrl);
  } catch (e) {
    notify("Save failed", e.message || "Could not reach Notion.");
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "";
  }
}

// ---- Wiring -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-link",
    title: "Save link to Notion",
    contexts: ["link"],
  });
  chrome.contextMenus.create({
    id: "save-page",
    title: "Save this page to Notion",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "save-link") {
    saveLink(info.linkUrl, info.selectionText || "", tab && tab.id);
  } else if (info.menuItemId === "save-page") {
    savePage(tab, info.selectionText || "");
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "instant-save") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    savePage(tab);
  }
});
