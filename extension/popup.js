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
    status.update ? "update" : cooldownActive ? "cooldown" : status.online ? "online" : "offline"
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
  const updateCard = document.querySelector("#update-card");
  updateCard.hidden = !status.update;
  if (status.update) {
    document.querySelector("#update-detail").textContent =
      `Installiert: ${status.update.currentVersion}. Verfügbar: ${status.update.latestVersion}. ` +
      "Der Browser prüft zuerst den Shop. Ist dort kein Update verfügbar, wird die aktuelle ZIP geöffnet.";
  } else {
    document.querySelector("#update-detail").textContent = "";
    document.querySelector("#update-feedback").textContent = "";
  }
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
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
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

async function requestUpdate() {
  const button = document.querySelector("#request-update");
  const feedback = document.querySelector("#update-feedback");
  button.disabled = true;
  feedback.className = "pending";
  feedback.textContent = "Browser-Update wird geprüft …";
  try {
    const result = await message({ type: "request-update" });
    feedback.className = "success";
    feedback.textContent =
      result.browserStatus === "update_available"
        ? "Update gefunden. Die Erweiterung wird neu geladen."
        : result.manualDownloadOpened
          ? "ZIP geöffnet. Dateien im bisher geladenen Ordner ersetzen und erst danach neu laden."
          : "Shop-Prüfung beendet. Bitte die Anleitung für die manuelle Aktualisierung öffnen.";
  } catch {
    feedback.className = "error";
    feedback.textContent = "Automatische Shop-Prüfung nicht möglich. Bitte die Anleitung öffnen.";
  } finally {
    button.disabled = false;
  }
}

for (const button of document.querySelectorAll(".report-option")) {
  button.addEventListener("click", () => submitReport(button.dataset.category));
}
document.querySelector("#retry").addEventListener("click", () => updateStatus(true));
document.querySelector("#request-update").addEventListener("click", requestUpdate);
document.querySelector("#open-settings").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});
loadCurrentDomain().catch(() => {
  renderCurrentDomain(null);
});
updateStatus();
