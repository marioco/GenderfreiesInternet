"use strict";

const CONSENT_KEY = "shareAnonymousStatisticsV1";
const FILTER_LIGHT_KEY = "blockLightGenderingV1";
const PENDING_KEY = "pendingHiddenStatisticsV1";
const checkbox = document.querySelector("#share-statistics");
const filterChoices = [...document.querySelectorAll('input[name="filter-level"]')];
const filterStatusLine = document.querySelector("#filter-status");
const statusLine = document.querySelector("#settings-status");

function showStatus(text, failed = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle("status-error", failed);
}

function showFilterStatus(blockLight, failed = false) {
  filterStatusLine.textContent = blockLight
    ? "Filter aktiv: hartes und leichtes Gendern."
    : "Standardfilter aktiv: nur hartes Gendern.";
  filterStatusLine.classList.toggle("status-error", failed);
}

function selectFilterLevel(blockLight) {
  for (const choice of filterChoices) {
    choice.checked = choice.value === (blockLight ? "hard-light" : "hard");
  }
}

async function initialize() {
  try {
    const filterStored = await chrome.storage.local.get(FILTER_LIGHT_KEY);
    const blockLight = filterStored[FILTER_LIGHT_KEY] === true;
    selectFilterLevel(blockLight);
    showFilterStatus(blockLight);
  } catch (error) {
    selectFilterLevel(false);
    showFilterStatus(false, true);
    filterStatusLine.textContent = `Filterstärke konnte nicht geladen werden: ${error.message}`;
  }

  try {
    const stored = await chrome.storage.local.get(CONSENT_KEY);
    checkbox.checked = stored[CONSENT_KEY] === true;
    showStatus(
      checkbox.checked ? "Freiwillige Statistik ist eingeschaltet." : "Freiwillige Statistik ist aus.",
    );
  } catch (error) {
    checkbox.checked = false;
    showStatus(`Einstellung konnte nicht geladen werden: ${error.message}`, true);
  }
}

for (const choice of filterChoices) {
  choice.addEventListener("change", async () => {
    if (!choice.checked) return;
    const blockLight = choice.value === "hard-light";
    for (const item of filterChoices) item.disabled = true;
    try {
      await chrome.storage.local.set({ [FILTER_LIGHT_KEY]: blockLight });
      showFilterStatus(blockLight);
    } catch (error) {
      try {
        const stored = await chrome.storage.local.get(FILTER_LIGHT_KEY);
        selectFilterLevel(stored[FILTER_LIGHT_KEY] === true);
      } catch {
        selectFilterLevel(false);
      }
      showFilterStatus(false, true);
      filterStatusLine.textContent = `Filterstärke konnte nicht gespeichert werden: ${error.message}`;
    } finally {
      for (const item of filterChoices) item.disabled = false;
    }
  });
}

checkbox.addEventListener("change", async () => {
  checkbox.disabled = true;
  try {
    await chrome.storage.local.set({ [CONSENT_KEY]: checkbox.checked });
    if (!checkbox.checked) await chrome.storage.local.remove(PENDING_KEY);
    showStatus(
      checkbox.checked
        ? "Freiwillige Statistik ist eingeschaltet."
        : "Statistik ist aus; lokale Zähler wurden gelöscht.",
    );
  } catch (error) {
    try {
      const stored = await chrome.storage.local.get(CONSENT_KEY);
      checkbox.checked = stored[CONSENT_KEY] === true;
    } catch {
      checkbox.checked = false;
    }
    showStatus(`Einstellung konnte nicht gespeichert werden: ${error.message}`, true);
  } finally {
    checkbox.disabled = false;
  }
});

initialize().catch((error) => showStatus(`Einstellung konnte nicht geladen werden: ${error.message}`, true));
