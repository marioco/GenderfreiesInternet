"use strict";

let apiBaseUrl = null;
let currentDomain = null;
let cooldownActive = false;

function message(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else if (!response?.ok) reject(new Error(response?.error || "Erweiterungsanfrage fehlgeschlagen"));
      else resolve(response.value);
    });
  });
}

function renderStatus(status) {
  if (typeof status.apiBaseUrl === "string") apiBaseUrl = status.apiBaseUrl;
  const dot = document.querySelector("#status-dot");
  dot.className = `status-dot ${status.online ? "online" : "offline"}`;
  cooldownActive = Boolean(status.cooldown);
  document.querySelector(".logo").className = `logo ${
    cooldownActive ? "cooldown" : status.online ? "online" : "offline"
  }`;
  document.querySelector("#status-title").textContent = status.online
    ? "Filterdienst ist bereit"
    : "Filterdienst nicht erreichbar";
  const detail = document.querySelector("#status-detail");
  detail.hidden = status.online;
  detail.textContent = status.online ? "" : "Neu prüfen und lokalen Netzwerkzugriff erlauben.";
  const cooldownCard = document.querySelector("#cooldown-card");
  cooldownCard.hidden = !cooldownActive;
  document.querySelector("#cooldown-detail").textContent = cooldownActive
    ? `Noch ${status.cooldown.label}. Danach sind Meldungen wieder möglich.`
    : "";
  enableReportButtons(currentDomain !== null);
}

function activeTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(tabs[0] || null);
    });
  });
}

function domainFromTab(tab) {
  if (typeof tab?.url !== "string") return null;
  try {
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return isSearchEngineDomain(hostname) ? null : hostname;
  } catch {
    return null;
  }
}

function isSearchEngineDomain(hostname) {
  if (
    hostname === "news.google.com" ||
    hostname === "search.brave.com" ||
    hostname === "bing.com" ||
    hostname.endsWith(".bing.com") ||
    hostname === "duckduckgo.com" ||
    hostname.endsWith(".duckduckgo.com")
  )
    return true;
  return /^(?:www\.)?google\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(hostname);
}

function enableReportButtons(enabled) {
  for (const button of document.querySelectorAll(".report-option")) {
    button.disabled = !enabled || cooldownActive;
  }
}

function renderCurrentDomain(domain) {
  const current = document.querySelector("#current-domain");
  const unavailable = document.querySelector("#report-unavailable");
  currentDomain = domain;
  current.hidden = domain === null;
  unavailable.hidden = domain !== null;
  if (domain !== null) current.textContent = domain;
  enableReportButtons(domain !== null);
}

async function loadCurrentDomain() {
  const domain = domainFromTab(await activeTab());
  renderCurrentDomain(domain);
}

async function submitReport(category) {
  if (currentDomain === null || !["hard", "light"].includes(category)) return;
  const feedback = document.querySelector("#report-feedback");
  enableReportButtons(false);
  feedback.className = "pending";
  feedback.textContent = "Meldung wird gesendet …";
  try {
    const receipt = await message({ type: "report", domain: currentDomain, category });
    feedback.className = "success";
    feedback.textContent = receipt.duplicate ? "Bereits gemeldet." : "Zur Prüfung eingereicht.";
  } catch (error) {
    feedback.className = "error";
    if (error.message.startsWith("Ungewöhnliche Meldefrequenz")) {
      feedback.textContent = error.message;
      await updateStatus();
    } else {
      feedback.textContent = "Meldung fehlgeschlagen. Bitte Verbindung prüfen.";
    }
  } finally {
    enableReportButtons(currentDomain !== null);
  }
}

async function requestLocalNetworkAccess() {
  if (apiBaseUrl === null) return;
  const response = await fetch(`${apiBaseUrl}/readyz`, {
    cache: "no-store",
    credentials: "omit",
    mode: "cors",
    redirect: "error",
    targetAddressSpace: "local",
  });
  if (!response.ok) throw new Error(`Lokaler Filterdienst antwortet mit HTTP ${response.status}`);
}

async function updateStatus(interactive = false) {
  const retry = document.querySelector("#retry");
  retry.disabled = true;
  try {
    if (interactive) {
      try {
        await requestLocalNetworkAccess();
      } catch {
        // Die anschliessende Statusabfrage liefert die sichtbare Fehlermeldung.
      }
    }
    renderStatus(await message({ type: "status" }));
  } catch {
    renderStatus({ online: false });
  } finally {
    retry.disabled = false;
  }
}

for (const button of document.querySelectorAll(".report-option")) {
  button.addEventListener("click", () => submitReport(button.dataset.category));
}
document.querySelector("#retry").addEventListener("click", () => updateStatus(true));
document.querySelector("#open-settings").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});
loadCurrentDomain().catch(() => {
  renderCurrentDomain(null);
});
updateStatus();
