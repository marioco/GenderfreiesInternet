"use strict";

(() => {
  const browserApi = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
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
  const RETRY_DELAYS_MS = [250, 1000, 5000];
  const FILTER_LIGHT_KEY = "blockLightGenderingV1";
  const PREDEFINED_EXCEPTIONS_KEY = "predefinedDomainExceptionsV1";
  const CUSTOM_EXCEPTIONS_KEY = "customDomainExceptionsV1";
  const DATASET_SHARD_KEY_PREFIX = "signedDatasetShardV1:";
  const GOOGLE_NEWS_RESOLVE_CONCURRENCY = 2;
  const GOOGLE_NEWS_RPC_MAX_BYTES = 2_000_000;
  const GOOGLE_NEWS_ARTICLE_MAX_BYTES = 3_000_000;
  const GOOGLE_NEWS_FETCH_TIMEOUT_MS = 10_000;
  const GOOGLE_NEWS_RESOLUTION_CACHE_MS = 10 * 60 * 1000;
  const GOOGLE_NEWS_FAILURE_CACHE_MS = 30 * 1000;
  const GOOGLE_NEWS_RETRY_DELAYS_MS = [250, 1000, 5000];
  const GOOGLE_NEWS_MAX_CACHE_ENTRIES = 500;
  const GOOGLE_NEWS_MAX_RPC_NODES = 10_000;
  const GOOGLE_NEWS_ARTICLE_ID = /^[A-Za-z0-9_-]{20,2048}$/;
  const googleNewsResolutionPromises = new Map();
  let processed = new WeakMap();
  let failedLookups = new WeakMap();
  let googleNewsIdsByRoot = new WeakMap();
  let failedGoogleNewsResolutions = new WeakMap();
  let scheduled = false;
  let scanning = false;
  let rescanRequested = false;

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

  function googleNewsArticleId(anchor) {
    if (location.hostname !== "news.google.com") return null;
    let candidate;
    try {
      candidate = new URL(anchor.href, location.href);
    } catch {
      return null;
    }
    if (candidate.hostname !== "news.google.com") return null;
    const match = candidate.pathname.match(/^\/(?:read|articles|rss\/articles)\/([^/]+)\/?$/);
    if (!match || !GOOGLE_NEWS_ARTICLE_ID.test(match[1])) return null;
    return match[1];
  }

  function externalUrl(value) {
    try {
      const candidate = new URL(value);
      if (!["http:", "https:"].includes(candidate.protocol)) return null;
      if (
        candidate.username ||
        candidate.password ||
        !candidate.hostname.includes(".") ||
        SEARCH_WRAPPER_HOSTS.has(candidate.hostname) ||
        candidate.hostname.endsWith(".google.com") ||
        candidate.hostname.endsWith(".google.de")
      )
        return null;
      return candidate;
    } catch {
      return null;
    }
  }

  async function responseText(response, maxBytes) {
    const declaredLength = response.headers?.get?.("Content-Length");
    if (declaredLength && /^[0-9]+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
      throw new Error("Antwort ist unerwartet groß");
    }
    if (!response.body?.getReader) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw new Error("Antwort ist unerwartet groß");
      }
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("Antwort ist unerwartet groß");
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      if (error instanceof TypeError) throw new Error("Antwort enthält ungültigen Text", { cause: error });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async function fetchText(url, options, maxBytes) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GOOGLE_NEWS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "follow",
        ...options,
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await responseText(response, maxBytes);
      return { response, text };
    } finally {
      clearTimeout(timeout);
    }
  }

  function googleNewsDecodeParameters(html, articleId) {
    const documentNode = new DOMParser().parseFromString(html, "text/html");
    for (const node of documentNode.querySelectorAll("[data-n-a-id][data-n-a-ts][data-n-a-sg]")) {
      if (node.getAttribute("data-n-a-id") !== articleId) continue;
      const timestamp = node.getAttribute("data-n-a-ts") || "";
      const signature = node.getAttribute("data-n-a-sg") || "";
      const numericTimestamp = Number(timestamp);
      if (
        /^[0-9]{1,20}$/.test(timestamp) &&
        Number.isSafeInteger(numericTimestamp) &&
        numericTimestamp > 0 &&
        signature.length > 0 &&
        signature.length <= 4096
      )
        return { signature, timestamp: numericTimestamp };
    }
    return null;
  }

  function googleNewsRpcUrl(responseText) {
    const frames = [];
    for (const line of responseText.split("\n")) {
      const value = line.trim();
      if (!value.startsWith("[")) continue;
      try {
        frames.push(JSON.parse(value));
      } catch {
        // Längenangaben und unvollständige Zeilen gehören nicht zum JSON-Rahmen.
      }
    }
    const pending = [...frames].slice(0, GOOGLE_NEWS_MAX_RPC_NODES);
    let next = 0;
    let inspected = 0;
    while (next < pending.length && inspected < GOOGLE_NEWS_MAX_RPC_NODES) {
      inspected += 1;
      const value = pending[next];
      next += 1;
      if (!Array.isArray(value)) continue;
      if (value[0] === "wrb.fr" && value[1] === "Fbv4je" && typeof value[2] === "string") {
        try {
          const payload = JSON.parse(value[2]);
          if (payload?.[0] === "garturlres") return externalUrl(payload[1]);
        } catch {
          return null;
        }
      }
      for (const child of value) {
        if (Array.isArray(child) && pending.length < GOOGLE_NEWS_MAX_RPC_NODES) pending.push(child);
      }
    }
    return null;
  }

  async function resolveGoogleNewsRedirect(articleId) {
    const existing = [...document.querySelectorAll("[data-n-a-id][data-n-a-ts][data-n-a-sg]")].find(
      (node) => node.getAttribute("data-n-a-id") === articleId,
    );
    let parameters = existing
      ? {
          signature: existing.getAttribute("data-n-a-sg") || "",
          timestamp: Number(existing.getAttribute("data-n-a-ts")),
        }
      : null;
    if (!parameters?.signature || !Number.isSafeInteger(parameters.timestamp) || parameters.timestamp <= 0) {
      const article = new URL(`/rss/articles/${articleId}`, location.origin);
      const { response, text } = await fetchText(
        article,
        { credentials: "same-origin" },
        GOOGLE_NEWS_ARTICLE_MAX_BYTES,
      );
      const redirected = externalUrl(response.url);
      if (redirected) return redirected;
      parameters = googleNewsDecodeParameters(text, articleId);
    }
    if (!parameters) return null;
    const inner = [
      "garturlreq",
      [
        ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
        "X",
        "X",
        1,
        [1, 1, 1],
        1,
        1,
        null,
        0,
        0,
        null,
        0,
      ],
      articleId,
      parameters.timestamp,
      parameters.signature,
    ];
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[["Fbv4je", JSON.stringify(inner), null, "generic"]]]),
    });
    const rpc = new URL("/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", location.origin);
    const { text } = await fetchText(
      rpc,
      {
        body,
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        method: "POST",
      },
      GOOGLE_NEWS_RPC_MAX_BYTES,
    );
    return googleNewsRpcUrl(text);
  }

  async function resolveGoogleNewsUrl(articleId) {
    const existing = googleNewsResolutionPromises.get(articleId);
    if (existing && Date.now() < existing.expiresAt) return existing.promise;
    const entry = {
      expiresAt: Date.now() + GOOGLE_NEWS_RESOLUTION_CACHE_MS,
      promise: resolveGoogleNewsRedirect(articleId).catch((error) => {
        console.warn("Suchfilter konnte Google-News-Quelle nicht auflösen:", error.message);
        return null;
      }),
    };
    entry.promise = entry.promise.then((result) => {
      if (result === null) entry.expiresAt = Date.now() + GOOGLE_NEWS_FAILURE_CACHE_MS;
      return result;
    });
    googleNewsResolutionPromises.delete(articleId);
    googleNewsResolutionPromises.set(articleId, entry);
    while (googleNewsResolutionPromises.size > GOOGLE_NEWS_MAX_CACHE_ENTRIES) {
      googleNewsResolutionPromises.delete(googleNewsResolutionPromises.keys().next().value);
    }
    return entry.promise;
  }

  async function mapWithConcurrency(values, concurrency, callback) {
    const results = new Array(values.length);
    let next = 0;
    async function worker() {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await callback(values[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
    return results;
  }

  function anchorsWithin(root) {
    const anchors = [];
    if (root.matches?.("a[href]")) anchors.push(root);
    anchors.push(...root.querySelectorAll("a[href]"));
    return anchors;
  }

  function resultAnchor(root) {
    for (const anchor of anchorsWithin(root)) {
      if (
        anchor.querySelector("h3") ||
        anchor.closest("h3") ||
        anchor.getAttribute("data-testid") === "result-title-a"
      ) {
        if (resultUrl(root, anchor) || googleNewsArticleId(anchor)) return anchor;
      }
    }
    return (
      anchorsWithin(root).find((anchor) => resultUrl(root, anchor) || googleNewsArticleId(anchor)) || null
    );
  }

  function inferredGoogleNewsResultRoot(anchor) {
    const articleId = googleNewsArticleId(anchor);
    if (!articleId) return null;
    let candidate = anchor;
    let current = anchor.parentElement;
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (["HTML", "BODY", "MAIN"].includes(current.tagName) || current.getAttribute("role") === "main")
        break;
      const articleIds = new Set();
      for (const nestedAnchor of anchorsWithin(current)) {
        const nestedId = googleNewsArticleId(nestedAnchor);
        if (nestedId) articleIds.add(nestedId);
        if (articleIds.size > 1) break;
      }
      if (articleIds.size !== 1 || !articleIds.has(articleId)) break;
      candidate = current;
      if (current.matches("article, [role='article']")) break;
      current = current.parentElement;
    }
    return candidate;
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
    if (location.hostname === "news.google.com") {
      for (const anchor of document.querySelectorAll("a[href]")) {
        if (!googleNewsArticleId(anchor)) continue;
        if (values.some((root) => root === anchor || root.contains(anchor))) continue;
        const inferred = inferredGoogleNewsResultRoot(anchor);
        if (inferred) values.push(inferred);
      }
    }
    return [...new Set(values)].filter((root) => resultAnchor(root));
  }

  function message(payload) {
    return new Promise((resolve, reject) => {
      browserApi.runtime.sendMessage(payload, (response) => {
        if (browserApi.runtime.lastError) reject(browserApi.runtime.lastError);
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

  async function applyResolvedStatuses(candidates) {
    const pending = candidates.filter(({ root, url }) => processed.get(root) !== url.href);
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      const hostnames = batch.map(({ url }) => url.hostname);
      try {
        const statuses = await message({ type: "lookup", hostnames });
        const hiddenDomains = [];
        const retryItems = [];
        batch.forEach(({ root, url }, index) => {
          processed.set(root, url.href);
          const status = statuses[index] || { domain: hostnames[index], state: null, known: false };
          decorate(root, status);
          if (status.retry === true && !status.known) {
            const previous = failedLookups.get(root);
            const attempts = previous?.href === url.href ? previous.attempts + 1 : 1;
            failedLookups.set(root, { attempts, href: url.href });
            if (attempts <= RETRY_DELAYS_MS.length) retryItems.push({ attempts, root, url });
          } else {
            failedLookups.delete(root);
          }
          if (status.state === "blocked") hiddenDomains.push(status.domain || hostnames[index]);
        });
        scheduleRetries(retryItems);
        if (hiddenDomains.length) {
          message({ type: "hidden", domains: hiddenDomains }).catch((error) =>
            console.warn("Suchfilter konnte Ausblendungszaehler nicht vormerken:", error.message),
          );
        }
      } catch (error) {
        console.warn("Suchfilter konnte Status nicht laden:", error.message);
        const retryItems = [];
        batch.forEach(({ root, url }, index) => {
          const previous = failedLookups.get(root);
          const attempts = previous?.href === url.href ? previous.attempts + 1 : 1;
          failedLookups.set(root, { attempts, href: url.href });
          processed.set(root, url.href);
          decorate(root, { domain: hostnames[index], state: null, known: false });
          if (attempts <= RETRY_DELAYS_MS.length) retryItems.push({ attempts, root, url });
        });
        scheduleRetries(retryItems);
      }
    }
  }

  async function scan() {
    scheduled = false;
    if (scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;
    try {
      const discovered = roots().map((root) => {
        const anchor = resultAnchor(root);
        if (!anchor) return null;
        const direct = resultUrl(root, anchor);
        const articleId = googleNewsArticleId(anchor);
        if (!direct && articleId && googleNewsIdsByRoot.get(root) !== articleId) {
          googleNewsIdsByRoot.set(root, articleId);
          processed.delete(root);
          failedLookups.delete(root);
          failedGoogleNewsResolutions.delete(root);
          decorate(root, { domain: null, state: null, known: false });
        }
        return { articleId, direct, root };
      });
      const values = discovered.filter(Boolean);
      const direct = values.filter(({ direct }) => direct);
      for (const { root } of direct) failedGoogleNewsResolutions.delete(root);
      await applyResolvedStatuses(direct.map(({ direct, root }) => ({ root, url: direct })));
      const opaque = values.filter(({ articleId, direct, root }) => {
        if (direct || !articleId) return false;
        const failure = failedGoogleNewsResolutions.get(root);
        return failure?.articleId !== articleId || failure.retryAt <= Date.now();
      });
      for (let offset = 0; offset < opaque.length; offset += GOOGLE_NEWS_RESOLVE_CONCURRENCY) {
        const resolved = await mapWithConcurrency(
          opaque.slice(offset, offset + GOOGLE_NEWS_RESOLVE_CONCURRENCY),
          GOOGLE_NEWS_RESOLVE_CONCURRENCY,
          async ({ articleId, root }) => ({ articleId, root, url: await resolveGoogleNewsUrl(articleId) }),
        );
        scheduleGoogleNewsResolutionRetries(resolved.filter(({ url }) => !url));
        for (const { root, url } of resolved) {
          if (url) failedGoogleNewsResolutions.delete(root);
        }
        await applyResolvedStatuses(resolved.filter(({ url }) => url));
      }
    } finally {
      scanning = false;
      if (rescanRequested) {
        rescanRequested = false;
        scheduleScan(0);
      }
    }
  }

  function scheduleGoogleNewsResolutionRetries(items) {
    for (const { articleId, root } of items) {
      const previous = failedGoogleNewsResolutions.get(root);
      const attempts = previous?.articleId === articleId ? previous.attempts + 1 : 1;
      const delay = GOOGLE_NEWS_RETRY_DELAYS_MS[attempts - 1];
      if (delay === undefined) {
        failedGoogleNewsResolutions.set(root, { articleId, attempts, retryAt: Number.POSITIVE_INFINITY });
        continue;
      }
      const retryAt = Date.now() + delay;
      failedGoogleNewsResolutions.set(root, { articleId, attempts, retryAt });
      setTimeout(() => {
        const failure = failedGoogleNewsResolutions.get(root);
        if (failure?.articleId !== articleId || failure.attempts !== attempts || failure.retryAt !== retryAt)
          return;
        googleNewsResolutionPromises.delete(articleId);
        failedGoogleNewsResolutions.set(root, { ...failure, retryAt: 0 });
        scheduleScan(0);
      }, delay);
    }
  }

  function scheduleRetries(items) {
    for (const { attempts, root, url } of items) {
      setTimeout(
        () => {
          const failure = failedLookups.get(root);
          if (failure?.href !== url.href || failure.attempts !== attempts || processed.get(root) !== url.href)
            return;
          processed.delete(root);
          scheduleScan(0);
        },
        RETRY_DELAYS_MS[attempts - 1],
      );
    }
  }

  function scheduleScan(delay = 80) {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => scan().catch((error) => console.error("Suchfilter-Scan fehlgeschlagen", error)), delay);
  }

  if (engine()) {
    scheduleScan();
    browserApi.storage?.onChanged?.addListener((changes, areaName) => {
      const changedKeys = Object.keys(changes || {});
      if (
        areaName !== "local" ||
        !(
          [FILTER_LIGHT_KEY, PREDEFINED_EXCEPTIONS_KEY, CUSTOM_EXCEPTIONS_KEY].some((key) =>
            Object.hasOwn(changes, key),
          ) ||
          changedKeys.some(
            (key) =>
              key.startsWith(DATASET_SHARD_KEY_PREFIX) &&
              changes[key]?.oldValue?.version !== changes[key]?.newValue?.version,
          )
        )
      )
        return;
      processed = new WeakMap();
      failedLookups = new WeakMap();
      googleNewsIdsByRoot = new WeakMap();
      failedGoogleNewsResolutions = new WeakMap();
      scheduleScan(0);
    });
    new MutationObserver(() => scheduleScan()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["href"],
      childList: true,
      subtree: true,
    });
  }
})();
