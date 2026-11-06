"use strict";

import "./exceptions.js";
import { CONFIG } from "./config.js";
import { datasetCachedDomainCount, lookupDataset, lookupDatasetCached } from "./dataset.js";
import { applyProofs, lookupCached, sanitizeCache, verifyEnvelope } from "./snapshot.js";

const {
  CUSTOM_KEY,
  PREDEFINED_KEY,
  classifyLocalDomain,
  sanitizeCustomDomains,
  sanitizePredefinedOverrides,
} = globalThis.SuchfilterExceptions;

const CACHE_KEY = "signedDomainCacheV1";
const INSTALLATION_KEY = "installationIdV1";
const REPORT_COOLDOWN_KEY = "reportCooldownV1";
const FILTER_LIGHT_KEY = "blockLightGenderingV1";
const TELEMETRY_CONSENT_KEY = "shareAnonymousStatisticsV1";
const TELEMETRY_STATE_KEY = "pendingHiddenStatisticsV1";
const INSTALLATION_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const BATCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TELEMETRY_BATCH = 100;
const MAX_TELEMETRY_DOMAINS = 1000;
const LOCAL_TELEMETRY_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_ALARM = "suchfilter-refresh";
const REPORT_COOLDOWN_ALARM = "suchfilter-report-cooldown";
const COOLDOWN_BADGE_COLOR = "#d97706";
const MAX_COOLDOWN_SECONDS = 604_800;
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

let currentOnline = false;
let currentCooldown = null;

function isReportableDomain(value) {
  if (typeof value !== "string") return false;
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_PATTERN.test(hostname)) return false;
  if (
    hostname === "news.google.com" ||
    hostname === "search.brave.com" ||
    hostname === "bing.com" ||
    hostname.endsWith(".bing.com") ||
    hostname === "duckduckgo.com" ||
    hostname.endsWith(".duckduckgo.com")
  )
    return false;
  return !/^(?:www\.)?google\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(hostname);
}

async function fetchWithTimeout(url, options = {}, controller = new AbortController()) {
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function validatedCooldown(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const now = Date.now();
  if (
    typeof raw.until !== "number" ||
    !Number.isFinite(raw.until) ||
    raw.until <= now ||
    raw.until > now + MAX_COOLDOWN_SECONDS * 1000 + 300_000
  )
    return null;
  return { until: raw.until };
}

function formatCooldownDuration(seconds) {
  const bounded = Math.max(1, Math.ceil(seconds));
  if (bounded < 5_400) {
    const minutes = Math.ceil(bounded / 60);
    return `${minutes} ${minutes === 1 ? "Minute" : "Minuten"}`;
  }
  if (bounded < 172_800) {
    const hours = Math.ceil(bounded / 3_600);
    return `${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
  }
  const days = Math.ceil(bounded / 86_400);
  return `${days} ${days === 1 ? "Tag" : "Tage"}`;
}

function cooldownStatus() {
  if (currentCooldown === null) return null;
  const remainingSeconds = Math.ceil((currentCooldown.until - Date.now()) / 1000);
  if (remainingSeconds < 1) return null;
  return {
    until: currentCooldown.until,
    remainingSeconds,
    label: formatCooldownDuration(remainingSeconds),
  };
}

async function loadStoredCooldown() {
  const stored = await chrome.storage.local.get(REPORT_COOLDOWN_KEY);
  const cooldown = validatedCooldown(stored[REPORT_COOLDOWN_KEY]);
  if (stored[REPORT_COOLDOWN_KEY] && cooldown === null) {
    await chrome.storage.local.remove(REPORT_COOLDOWN_KEY);
  }
  currentCooldown = cooldown;
  return cooldown;
}

async function ensureCooldownAlarm() {
  const alarm = await chrome.alarms.get(REPORT_COOLDOWN_ALARM);
  if (cooldownStatus() && !alarm) {
    await chrome.alarms.create(REPORT_COOLDOWN_ALARM, { periodInMinutes: 1 });
  } else if (!cooldownStatus() && alarm && chrome.alarms.clear) {
    await chrome.alarms.clear(REPORT_COOLDOWN_ALARM);
  }
}

async function saveCooldown(seconds) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_COOLDOWN_SECONDS) {
    throw new Error("Cooldown-Antwort ist ungültig");
  }
  const until = Date.now() + seconds * 1000;
  currentCooldown = { until: Math.max(until, currentCooldown?.until || 0) };
  await chrome.storage.local.set({ [REPORT_COOLDOWN_KEY]: currentCooldown });
  await ensureCooldownAlarm();
  await updateActionAppearance();
  return cooldownStatus();
}

async function updateActionAppearance(online = currentOnline) {
  currentOnline = online;
  const baseState = online ? "online" : "offline";
  const cooldown = cooldownStatus();
  const cooldownState = cooldown ? `cooldown-${Math.ceil(cooldown.remainingSeconds / 60)}` : "current";
  const state = `${baseState}-${cooldownState}`;
  if (renderedActionState === state || !chrome.action?.setIcon) return;
  try {
    await chrome.action.setIcon({ path: ACTION_ICONS[baseState] });
    if (chrome.action.setBadgeText) {
      await chrome.action.setBadgeText({ text: cooldown ? "!" : "" });
    }
    if (cooldown && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: COOLDOWN_BADGE_COLOR });
    }
    if (cooldown && chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
    if (chrome.action.setTitle) {
      await chrome.action.setTitle({
        title: cooldown
          ? `Ungewöhnliche Meldefrequenz – ${cooldown.label}`
          : online
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
      response = await fetchWithTimeout(
        `${CONFIG.apiBaseUrl}/v1/telemetry/hidden`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch_id: batch.batchId, domains: batch.domains }),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        },
        controller,
      );
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
  const response = await fetchWithTimeout(`${CONFIG.apiBaseUrl}/v2/domains/signed-batch`, {
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

async function blockLightPreference() {
  try {
    const stored = await chrome.storage.local.get(FILTER_LIGHT_KEY);
    return stored[FILTER_LIGHT_KEY] === true;
  } catch (error) {
    console.warn("Suchfilter verwendet den Hard-Standard:", error.message);
    return false;
  }
}

async function localDomainPreferences() {
  try {
    const [predefinedStored, customStored] = await Promise.all([
      chrome.storage.local.get(PREDEFINED_KEY),
      chrome.storage.local.get(CUSTOM_KEY),
    ]);
    return {
      customDomains: sanitizeCustomDomains(customStored[CUSTOM_KEY]),
      predefinedOverrides: sanitizePredefinedOverrides(predefinedStored[PREDEFINED_KEY]),
    };
  } catch (error) {
    console.warn("Suchfilter verwendet die Standardausnahmen:", error.message);
    return { customDomains: [], predefinedOverrides: {} };
  }
}

async function lookupCentral(hostnames) {
  if (CONFIG.datasetManifestUrl) {
    try {
      return await lookupDataset(hostnames, CONFIG);
    } catch (error) {
      console.warn("Suchfilter verwendet letzten gültigen Datenbestand:", error.message);
      return lookupDatasetCached(hostnames);
    }
  }
  let cache = await loadCache();
  if (hostnames.length) {
    try {
      cache = await refreshDomains(hostnames);
    } catch (error) {
      console.warn("Suchfilter verwendet letzten gültigen Cache:", error.message);
    }
  }
  return hostnames.map((hostname) => lookupCached(hostname, cache));
}

async function lookup(hostnames) {
  const preferences = await localDomainPreferences();
  const localStatuses = hostnames.map((hostname) =>
    classifyLocalDomain(hostname, preferences.predefinedOverrides, preferences.customDomains),
  );
  const centralHostnames = hostnames.filter((_hostname, index) => localStatuses[index] === null);
  if (!centralHostnames.length) return localStatuses;
  const centralStatuses = await lookupCentral(centralHostnames);
  const blockLight = await blockLightPreference();
  let centralIndex = 0;
  return localStatuses.map((localStatus) => {
    if (localStatus !== null) return localStatus;
    const status = centralStatuses[centralIndex] || {
      domain: centralHostnames[centralIndex],
      known: false,
      state: null,
    };
    centralIndex += 1;
    if (status.state === "blocked" && status.filterCategory === "light" && !blockLight) {
      return { ...status, state: "verified" };
    }
    return status;
  });
}

async function report(domain, category) {
  if (!isReportableDomain(domain) || !["hard", "light"].includes(category)) {
    throw new Error("Diese Seite kann nicht gemeldet werden");
  }
  await loadStoredCooldown();
  const activeCooldown = cooldownStatus();
  if (activeCooldown) {
    throw new Error(`Ungewöhnliche Meldefrequenz – ${activeCooldown.label}`);
  }
  const response = await fetchWithTimeout(`${CONFIG.apiBaseUrl}/v1/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, category, installation_id: await installationId() }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (response.status === 429) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const headerValue = response.headers?.get?.("Retry-After");
    const headerSeconds = headerValue === null || headerValue === undefined ? NaN : Number(headerValue);
    const seconds = Number.isInteger(payload?.cooldown_seconds)
      ? payload.cooldown_seconds
      : Number.isInteger(headerSeconds)
        ? headerSeconds
        : NaN;
    const cooldown = await saveCooldown(seconds);
    throw new Error(`Ungewöhnliche Meldefrequenz – ${cooldown.label}`);
  }
  if (!response.ok) throw new Error(`Meldung fehlgeschlagen (${response.status})`);
  return response.json();
}

async function status() {
  await loadStoredCooldown();
  await ensureCooldownAlarm();
  const cachedDomains = CONFIG.datasetManifestUrl
    ? await datasetCachedDomainCount()
    : Object.keys((await loadCache()).entries || {}).length;
  let online = false;
  try {
    const response = await fetchWithTimeout(`${CONFIG.apiBaseUrl}/readyz`, {
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
    cachedDomains,
    apiBaseUrl: CONFIG.apiBaseUrl,
    cooldown: cooldownStatus(),
  };
}

async function ensureRefreshAlarm() {
  const alarm = await chrome.alarms.get(REFRESH_ALARM);
  if (!alarm || alarm.periodInMinutes !== CONFIG.syncIntervalMinutes) {
    if (alarm && chrome.alarms.clear) await chrome.alarms.clear(REFRESH_ALARM);
    await chrome.alarms.create(REFRESH_ALARM, {
      periodInMinutes: CONFIG.syncIntervalMinutes,
    });
  }
}

async function openOnboarding(details) {
  if (details?.reason !== "install") return;
  if (!chrome.runtime.getURL || !chrome.tabs?.create) {
    console.warn("Suchfilter-Einrichtung konnte nicht automatisch geöffnet werden");
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
}

ensureRefreshAlarm().catch((error) =>
  console.error("Suchfilter-Aktualisierungsalarm konnte nicht eingerichtet werden", error),
);

loadStoredCooldown()
  .then(() => ensureCooldownAlarm())
  .then(() => updateActionAppearance(false))
  .then(() => status())
  .catch((error) => console.warn("Suchfilter-Startprüfung fehlgeschlagen:", error.message));

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local
    .remove("availableExtensionUpdateV1")
    .catch((error) => console.warn("Veralteter Updatezustand konnte nicht gelöscht werden:", error.message));
  installationId().catch((error) => console.error("Installationskennung fehlgeschlagen", error));
  status().catch((error) => console.warn("Suchfilter-Installationsprüfung fehlgeschlagen:", error.message));
  openOnboarding(details).catch((error) =>
    console.warn("Suchfilter-Einrichtung konnte nicht geöffnet werden:", error.message),
  );
});

chrome.runtime.onUpdateAvailable?.addListener(() => {
  chrome.runtime.reload();
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    !Object.hasOwn(changes, TELEMETRY_CONSENT_KEY) ||
    changes[TELEMETRY_CONSENT_KEY]?.newValue === true
  )
    return;
  telemetryAbortController?.abort();
  withTelemetryLock(() => chrome.storage.local.remove(TELEMETRY_STATE_KEY)).catch((error) =>
    console.warn("Lokale Statistikzaehler konnten nicht geloescht werden:", error.message),
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REPORT_COOLDOWN_ALARM) {
    loadStoredCooldown()
      .then(() => ensureCooldownAlarm())
      .then(() => updateActionAppearance())
      .catch((error) => console.warn("Cooldown-Anzeige konnte nicht aktualisiert werden:", error.message));
    return;
  }
  if (alarm.name !== REFRESH_ALARM) return;
  status().catch((error) => console.warn("Suchfilter-Statusprüfung fehlgeschlagen:", error.message));
  flushTelemetry().catch((error) =>
    console.warn("Suchfilter-Statistik wartet auf Wiederholung:", error.message),
  );
  const updateTask = CONFIG.datasetManifestUrl
    ? lookupDataset([], CONFIG)
    : loadCache().then((cache) =>
        refreshDomains(
          Object.entries(cache.entries || {})
            .sort(([, left], [, right]) => Date.parse(left.verifiedAt) - Date.parse(right.verifiedAt))
            .map(([domain]) => domain),
        ),
      );
  updateTask.catch((error) => console.warn("Suchfilter-Aktualisierung fehlgeschlagen:", error.message));
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
