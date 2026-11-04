"use strict";

(() => {
  const ENGINE_RULES = [
    { host: /^(?:www\.)?google\.(?:de|com)$/, selectors: ["div.MjjYud", "div.g", "div.SoaBEf"] },
    { host: /^news\.google\.com$/, selectors: ["article", "div.SoaBEf"] },
    { host: /^www\.bing\.com$/, selectors: ["li.b_algo", "div.news-card"] },
    { host: /^search\.brave\.com$/, selectors: ["div.snippet", "div[data-type='web']"] },
    { host: /^(?:html\.)?duckduckgo\.com$/, selectors: ["article[data-testid='result']", "div.result"] },
  ];
  const WRAPPER_KEYS = ["url", "q", "uddg", "u", "target"];
  const SEARCH_WRAPPER_HOSTS = new Set([
    "google.de",
    "www.google.de",
    "google.com",
    "www.google.com",
    "news.google.com",
    "www.bing.com",
    "search.brave.com",
    "duckduckgo.com",
    "html.duckduckgo.com",
  ]);
  const processed = new WeakMap();
  let scheduled = false;

  function engine() {
    return ENGINE_RULES.find((rule) => rule.host.test(location.hostname)) || null;
  }

  function targetUrl(anchor) {
    let candidate;
    try {
      candidate = new URL(anchor.href, location.href);
    } catch {
      return null;
    }
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return null;
    if (SEARCH_WRAPPER_HOSTS.has(candidate.hostname)) {
      for (const key of WRAPPER_KEYS) {
        const wrapped = candidate.searchParams.get(key);
        if (!wrapped) continue;
        const values = [];
        try {
          values.push(decodeURIComponent(wrapped));
        } catch {
          values.push(wrapped);
        }
        if (values[0].length <= 4096 && /^a1[A-Za-z0-9_-]+$/.test(values[0])) {
          try {
            const encoded = values[0].slice(2).replace(/-/g, "+").replace(/_/g, "/");
            values.push(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
          } catch {
            // Die sichtbare Quellenangabe bleibt als sichere Rueckfallebene.
          }
        }
        for (const value of values) {
          try {
            const decoded = new URL(value);
            if (["http:", "https:"].includes(decoded.protocol) && !SEARCH_WRAPPER_HOSTS.has(decoded.hostname))
              return decoded;
          } catch {
            // Andere Wrapperparameter werden weiter geprueft.
          }
        }
      }
    }
    return SEARCH_WRAPPER_HOSTS.has(candidate.hostname) ? null : candidate;
  }

  function displayedResultUrl(root) {
    const values = [];
    for (const node of [root, ...root.querySelectorAll("[data-dtld], [data-url], [data-pcu]")]) {
      for (const name of ["data-dtld", "data-url", "data-pcu"]) {
        const value = node.getAttribute(name);
        if (value) values.push(value);
      }
    }
    for (const cite of root.querySelectorAll("cite")) values.push(cite.textContent || "");
    for (const rawValue of values) {
      if (rawValue.length > 4096) continue;
      const value = rawValue
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
        .trim()
        .split(/[\s›»]+/u)[0]
        .replace(/^[([{]+|[)\]},;]+$/g, "");
      if (!value) continue;
      try {
        const candidate = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
        if (
          ["http:", "https:"].includes(candidate.protocol) &&
          candidate.hostname.includes(".") &&
          !SEARCH_WRAPPER_HOSTS.has(candidate.hostname)
        )
          return candidate;
      } catch {
        // Weitere strukturierte Quellenangaben werden geprueft.
      }
    }
    return null;
  }

  function resultUrl(root, anchor) {
    return targetUrl(anchor) || displayedResultUrl(root);
  }

  function resultAnchor(root) {
    for (const anchor of root.querySelectorAll("a[href]")) {
      if (
        anchor.querySelector("h3") ||
        anchor.closest("h3") ||
        anchor.getAttribute("data-testid") === "result-title-a"
      ) {
        if (resultUrl(root, anchor)) return anchor;
      }
    }
    return [...root.querySelectorAll("a[href]")].find((anchor) => resultUrl(root, anchor)) || null;
  }

  function inferredGoogleResultRoot(heading) {
    const anchor = heading.closest("a[href]");
    if (!anchor) return null;
    let current = anchor.parentElement;
    let candidate = null;
    while (
      current &&
      !["BODY", "MAIN"].includes(current.tagName) &&
      !["search", "rso"].includes(current.id)
    ) {
      const titles = current.querySelectorAll("a[href] h3");
      if (titles.length !== 1 || titles[0] !== heading) break;
      candidate = current;
      current = current.parentElement;
    }
    return candidate && resultUrl(candidate, anchor) ? candidate : null;
  }

  function roots() {
    const rule = engine();
    if (!rule) return [];
    const values = [];
    for (const selector of rule.selectors) values.push(...document.querySelectorAll(selector));
    if (/^(?:www\.)?google\.(?:de|com)$/.test(location.hostname)) {
      for (const heading of document.querySelectorAll("a[href] h3")) {
        if (values.some((root) => root.contains(heading))) continue;
        const inferred = inferredGoogleResultRoot(heading);
        if (inferred) values.push(inferred);
      }
    }
    return [...new Set(values)].filter((root) => resultAnchor(root));
  }

  function message(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else if (!response?.ok) reject(new Error(response?.error || "Erweiterungsanfrage fehlgeschlagen"));
        else resolve(response.value);
      });
    });
  }

  function statusText(status) {
    if (status.state === "verified") return "Diese Domain wurde geprüft und bleibt sichtbar.";
    if (status.state === "exception") return "Diese Domain ist eine geprüfte Ausnahme und bleibt sichtbar.";
    return "Diese Domain wurde noch nicht geprüft.";
  }

  function decorate(root, status) {
    root.classList.toggle("suchfilter-hidden", status.state === "blocked");
    root.querySelector(":scope > .suchfilter-controls")?.remove();
    root.querySelector(":scope > .suchfilter-marker")?.remove();
    root.querySelector(":scope > .suchfilter-star")?.remove();
    if (status.state === "blocked") return;

    const marker = document.createElement("span");
    marker.className = "suchfilter-marker";

    const label = document.createElement("span");
    label.className = "suchfilter-label";
    label.textContent = "GF";
    label.setAttribute("aria-hidden", "true");

    const badge = document.createElement("span");
    badge.className = `suchfilter-star ${status.known ? "suchfilter-star-known" : "suchfilter-star-unknown"}`;
    badge.textContent = "★";
    badge.title = statusText(status);
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", statusText(status));

    marker.append(label, badge);
    root.prepend(marker);
  }

  async function scan() {
    scheduled = false;
    const candidates = roots()
      .map((root) => {
        const anchor = resultAnchor(root);
        return { root, url: anchor ? resultUrl(root, anchor) : null };
      })
      .filter((item) => item.url);
    const pending = candidates.filter(({ root, url }) => processed.get(root) !== url.href);
    if (!pending.length) return;
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      const hostnames = batch.map(({ url }) => url.hostname);
      try {
        const statuses = await message({ type: "lookup", hostnames });
        const hiddenDomains = [];
        batch.forEach(({ root, url }, index) => {
          processed.set(root, url.href);
          const status = statuses[index] || { domain: hostnames[index], state: null, known: false };
          decorate(root, status);
          if (status.state === "blocked") hiddenDomains.push(status.domain || hostnames[index]);
        });
        if (hiddenDomains.length) {
          message({ type: "hidden", domains: hiddenDomains }).catch((error) =>
            console.warn("Suchfilter konnte Ausblendungszaehler nicht vormerken:", error.message),
          );
        }
      } catch (error) {
        console.warn("Suchfilter konnte Status nicht laden:", error.message);
        batch.forEach(({ root, url }, index) => {
          processed.set(root, url.href);
          decorate(root, { domain: hostnames[index], state: null, known: false });
        });
      }
    }
  }

  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => scan().catch((error) => console.error("Suchfilter-Scan fehlgeschlagen", error)), 80);
  }

  if (engine()) {
    scheduleScan();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["href"],
      childList: true,
      subtree: true,
    });
  }
})();
