"use strict";

import { CONFIG } from "./config.js";
import { applyProofs, lookupCached, sanitizeCache, verifyEnvelope } from "./snapshot.js";

const CACHE_KEY = "signedDomainCacheV1";
const INSTALLATION_KEY = "installationIdV1";
const TELEMETRY_CONSENT_KEY = "shareAnonymousStatisticsV1";
const TELEMETRY_STATE_KEY = "pendingHiddenStatisticsV1";
const INSTALLATION_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const BATCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TELEMETRY_BATCH = 100;
const MAX_TELEMETRY_DOMAINS = 1000;
const LOCAL_TELEMETRY_DAYS = 7;
const ACTION_ICONS = {
  offline: {
    16: "gf-icon-offline-16.png",
    32: "gf-icon-offline-32.png",
  },
  online: {
    16: "gf-icon-16.png",
    32: "gf-icon-32.png",
  },
};
let installationTask = null;
let refreshQueue = Promise.resolve();
let telemetryQueue = Promise.resolve();
let telemetryFlushTask = null;
let telemetryAbortController = null;
let renderedActionState = null;

async function updateActionAppearance(online) {
  const state = online ? "online" : "offline";
  if (renderedActionState === state || !chrome.action?.setIcon) return;
  try {
    await chrome.action.setIcon({ path: ACTION_ICONS[state] });
    if (chrome.action.setTitle) {
      await chrome.action.setTitle({
        title: online
          ? "Genderfreies Internet – Filterdienst verfügbar"
          : "Genderfreies Internet – Filterdienst nicht verfügbar",
      });
    }
    renderedActionState = state;
  } catch (error) {
    console.warn("Suchfilter-Symbol konnte nicht aktualisiert werden:", error.message);
  }
}

function randomInstallationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function installationId() {
  if (installationTask === null) {
    installationTask = (async () => {
      const stored = await chrome.storage.local.get(INSTALLATION_KEY);
      if (INSTALLATION_PATTERN.test(stored[INSTALLATION_KEY])) return stored[INSTALLATION_KEY];
      const value = randomInstallationId();
      await chrome.storage.local.set({ [INSTALLATION_KEY]: value });
      return value;
    })().catch((error) => {
      installationTask = null;
      throw error;
    });
  }
  return installationTask;
}

async function loadCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = stored[CACHE_KEY];
  return sanitizeCache(cache);
}

async function saveCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

function withTelemetryLock(task) {
  const result = telemetryQueue.catch(() => undefined).then(task);
  telemetryQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isTelemetryDomain(domain) {
  if (typeof domain !== "string" || !DOMAIN_PATTERN.test(domain) || !domain.includes(".")) return false;
  return domain
    .split(".")
    .every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function recentLocalDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  const today = Date.parse(`${utcDay()}T00:00:00Z`);
  if (!Number.isFinite(parsed) || parsed > today || parsed < today - (LOCAL_TELEMETRY_DAYS - 1) * 86_400_000)
    return null;
  return value;
}

function sanitizedTelemetryState(raw) {
  const createdOn = recentLocalDay(raw?.createdOn);
  if (createdOn === null && (raw?.current || raw?.batches)) {
    return { batches: [], createdOn: utcDay(), current: {} };
  }
  const current = {};
  if (raw?.current && typeof raw.current === "object" && !Array.isArray(raw.current)) {
    for (const [domain, count] of Object.entries(raw.current).slice(0, MAX_TELEMETRY_DOMAINS)) {
      if (isTelemetryDomain(domain) && Number.isSafeInteger(count) && count > 0) {
        current[domain] = Math.min(count, 1_000_000);
      }
    }
  }
  const batches = [];
  if (Array.isArray(raw?.batches)) {
    for (const batch of raw.batches.slice(0, 100)) {
      if (
        typeof batch?.batchId !== "string" ||
        !BATCH_PATTERN.test(batch.batchId) ||
        !Array.isArray(batch.domains) ||
        batch.domains.length < 1 ||
        batch.domains.length > 100
      )
        continue;
      const domains = batch.domains.filter(
        (item) =>
          isTelemetryDomain(item?.domain) &&
          Number.isSafeInteger(item?.count) &&
          item.count >= 1 &&
          item.count <= MAX_TELEMETRY_BATCH,
      );
      if (
        domains.length === batch.domains.length &&
        domains.reduce((total, item) => total + item.count, 0) <= MAX_TELEMETRY_BATCH
      ) {
        batches.push({ batchId: batch.batchId, domains });
      }
    }
  }
  return { batches, createdOn: createdOn || utcDay(), current };
}

async function telemetryConsent() {
  const stored = await chrome.storage.local.get(TELEMETRY_CONSENT_KEY);
  return stored[TELEMETRY_CONSENT_KEY] === true;
}

async function recordHidden(domains) {
  if (!(await telemetryConsent())) return { recorded: 0 };
  const valid = domains.slice(0, 100).filter((domain) => isTelemetryDomain(domain));
  if (!valid.length) return { recorded: 0 };
  return withTelemetryLock(async () => {
    if (!(await telemetryConsent())) {
      await chrome.storage.local.remove(TELEMETRY_STATE_KEY);
      return { recorded: 0 };
    }
    const stored = await chrome.storage.local.get(TELEMETRY_STATE_KEY);
    const state = sanitizedTelemetryState(stored[TELEMETRY_STATE_KEY]);
    for (const domain of valid) {
      if (!Object.hasOwn(state.current, domain) && Object.keys(state.current).length >= MAX_TELEMETRY_DOMAINS)
        continue;
      state.current[domain] = Math.min((state.current[domain] || 0) + 1, 1_000_000);
    }
    await chrome.storage.local.set({ [TELEMETRY_STATE_KEY]: state });
    return { recorded: valid.length };
  });
}

function nextTelemetryBatch(state) {
  if (state.batches.length) return state.batches[0];
  let remaining = MAX_TELEMETRY_BATCH;
  const domains = [];
  for (const domain of Object.keys(state.current).sort()) {
    if (remaining === 0) break;
    const count = Math.min(state.current[domain], remaining);
    domains.push({ domain, count });
    state.current[domain] -= count;
    if (state.current[domain] === 0) delete state.current[domain];
    remaining -= count;
  }
  if (!domains.length) return null;
  const batch = { batchId: crypto.randomUUID(), domains };
  state.batches.push(batch);
  return batch;
}

async function prepareTelemetryBatch() {
  return withTelemetryLock(async () => {
    if (!(await telemetryConsent())) {
      await chrome.storage.local.remove(TELEMETRY_STATE_KEY);
      return null;
    }
    const stored = await chrome.storage.local.get(TELEMETRY_STATE_KEY);
    const state = sanitizedTelemetryState(stored[TELEMETRY_STATE_KEY]);
    const batch = nextTelemetryBatch(state);
    if (batch) await chrome.storage.local.set({ [TELEMETRY_STATE_KEY]: state });
    return batch;
  });
}

async function acknowledgeTelemetryBatch(batchId) {
  await withTelemetryLock(async () => {
    const stored = await chrome.storage.local.get(TELEMETRY_STATE_KEY);
    const state = sanitizedTelemetryState(stored[TELEMETRY_STATE_KEY]);
    state.batches = state.batches.filter((batch) => batch.batchId !== batchId);
    if (state.batches.length || Object.keys(state.current).length) {
      await chrome.storage.local.set({ [TELEMETRY_STATE_KEY]: state });
    } else {
      await chrome.storage.local.remove(TELEMETRY_STATE_KEY);
    }
  });
}

async function flushTelemetryNow() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const batch = await prepareTelemetryBatch();
    if (!batch) return;
    if (!(await telemetryConsent())) return;
    const controller = new AbortController();
    telemetryAbortController = controller;
    let response;
    try {
      response = await fetch(`${CONFIG.apiBaseUrl}/v1/telemetry/hidden`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: batch.batchId, domains: batch.domains }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      if (telemetryAbortController === controller) telemetryAbortController = null;
    }
    if (!response.ok) throw new Error(`Statistikübertragung fehlgeschlagen (${response.status})`);
    await acknowledgeTelemetryBatch(batch.batchId);
  }
}

function flushTelemetry() {
  if (telemetryFlushTask === null) {
    telemetryFlushTask = flushTelemetryNow().finally(() => {
      telemetryFlushTask = null;
    });
  }
  return telemetryFlushTask;
}

async function refreshDomainsNow(hostnames) {
  const domains = [...new Set(hostnames)].slice(0, 100);
  if (!domains.length || !Object.keys(CONFIG.publicKeys).length) return loadCache();
  const response = await fetch(`${CONFIG.apiBaseUrl}/v1/domains/signed-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domains }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Statusabfrage fehlgeschlagen (${response.status})`);
  const envelope = await response.json();
  const payload = await verifyEnvelope(envelope, CONFIG.publicKeys);
  const cache = applyProofs(await loadCache(), payload);
  await saveCache(cache);
  return cache;
}

function refreshDomains(hostnames) {
  const task = refreshQueue.catch(() => undefined).then(() => refreshDomainsNow(hostnames));
  refreshQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function lookup(hostnames) {
  let cache = await loadCache();
  if (hostnames.length) {
    try {
      // Jede neue Suchseite fragt den aktuellen Stand ab. Der signierte Cache ist
      // die ausfallsichere Rueckfallebene, nicht eine 30-Minuten-Sperre fuer neue
      // Moderationsentscheidungen.
      cache = await refreshDomains(hostnames);
    } catch (error) {
      console.warn("Suchfilter verwendet letzten gültigen Cache:", error.message);
    }
  }
  return hostnames.map((hostname) => lookupCached(hostname, cache));
}

async function report(domain, category) {
  const response = await fetch(`${CONFIG.apiBaseUrl}/v1/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, category, installation_id: await installationId() }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Meldung fehlgeschlagen (${response.status})`);
  return response.json();
}

async function status() {
  const cache = await loadCache();
  let online = false;
  try {
    const response = await fetch(`${CONFIG.apiBaseUrl}/readyz`, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (response.ok) {
      const payload = await response.json();
      online = payload?.status === "ready";
    }
  } catch {
    online = false;
  }
  await updateActionAppearance(online);
  return {
    online,
    cachedDomains: Object.keys(cache.entries || {}).length,
    apiBaseUrl: CONFIG.apiBaseUrl,
  };
}

async function ensureRefreshAlarm() {
  const alarm = await chrome.alarms.get("suchfilter-refresh");
  if (!alarm) {
    await chrome.alarms.create("suchfilter-refresh", {
      periodInMinutes: CONFIG.syncIntervalMinutes,
    });
  }
}

ensureRefreshAlarm().catch((error) =>
  console.error("Suchfilter-Aktualisierungsalarm konnte nicht eingerichtet werden", error),
);

updateActionAppearance(false)
  .then(() => status())
  .catch((error) => console.warn("Suchfilter-Startprüfung fehlgeschlagen:", error.message));

chrome.runtime.onInstalled.addListener(() => {
  installationId().catch((error) => console.error("Installationskennung fehlgeschlagen", error));
  status().catch((error) => console.warn("Suchfilter-Installationsprüfung fehlgeschlagen:", error.message));
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local" || changes[TELEMETRY_CONSENT_KEY]?.newValue === true) return;
  telemetryAbortController?.abort();
  withTelemetryLock(() => chrome.storage.local.remove(TELEMETRY_STATE_KEY)).catch((error) =>
    console.warn("Lokale Statistikzaehler konnten nicht geloescht werden:", error.message),
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "suchfilter-refresh") return;
  status().catch((error) => console.warn("Suchfilter-Statusprüfung fehlgeschlagen:", error.message));
  flushTelemetry().catch((error) =>
    console.warn("Suchfilter-Statistik wartet auf Wiederholung:", error.message),
  );
  loadCache()
    .then((cache) =>
      refreshDomains(
        Object.entries(cache.entries || {})
          .sort(([, left], [, right]) => Date.parse(left.verifiedAt) - Date.parse(right.verifiedAt))
          .map(([domain]) => domain),
      ),
    )
    .catch((error) => console.warn("Suchfilter-Aktualisierung fehlgeschlagen:", error.message));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const task =
    message?.type === "lookup"
      ? lookup(Array.isArray(message.hostnames) ? message.hostnames.slice(0, 100) : [])
      : message?.type === "report"
        ? report(message.domain, message.category)
        : message?.type === "hidden"
          ? recordHidden(Array.isArray(message.domains) ? message.domains : [])
          : message?.type === "status"
            ? status()
            : Promise.reject(new Error("Unbekannte Anfrage"));
  task
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
