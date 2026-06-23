// extract.js — page content extraction shared by the popup and the background
// service worker. `extractInPage` is injected into the target tab; `extractArticle`
// wraps the scripting calls.

// Runs IN the page. Relies on the global `Readability` injected just before it.
// Must be fully self-contained (no closure references) because it is serialized.
export function extractInPage() {
  function metaContent(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.content) return el.content;
    }
    return "";
  }

  let selection = "";
  try {
    selection = (window.getSelection() || "").toString().trim();
  } catch (_) {}

  let article = null;
  try {
    if (typeof Readability !== "undefined") {
      article = new Readability(document.cloneNode(true)).parse();
    }
  } catch (_) {}

  const rawText =
    (article && article.textContent) || document.body.innerText || "";
  let paragraphs = rawText
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);

  // Link-only hosts (e.g. YouTube): there's no real article, and the page text
  // is just UI/comments noise, so keep title + URL only (no body).
  const host = location.hostname.replace(/^www\./, "");
  const linkOnly =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be";
  if (linkOnly) paragraphs = [];

  // Cover image: prefer Open Graph / Twitter, fall back to a high-res favicon.
  let image = metaContent([
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]',
  ]);
  if (image && image.startsWith("//")) image = location.protocol + image;
  if (image && image.startsWith("/")) image = location.origin + image;

  let publishedTime =
    (article && article.publishedTime) ||
    metaContent([
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[name="date"]',
    ]);

  return {
    title: (article && article.title) || document.title || location.href,
    siteName: (article && article.siteName) || location.hostname,
    excerpt: (article && article.excerpt) || "",
    byline: (article && article.byline) || metaContent(['meta[name="author"]']),
    publishedTime: publishedTime || "",
    image: image || "",
    selection,
    paragraphs,
  };
}

// Inject Readability then run the extractor in the same isolated world.
export async function extractArticle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["lib/Readability.js"],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractInPage,
    });
    return result;
  } catch (e) {
    return null;
  }
}
