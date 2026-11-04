"use strict";

const CONSENT_KEY = "shareAnonymousStatisticsV1";
const PENDING_KEY = "pendingHiddenStatisticsV1";
const checkbox = document.querySelector("#share-statistics");
const statusLine = document.querySelector("#settings-status");

function showStatus(text, failed = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle("status-error", failed);
}

async function initialize() {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  checkbox.checked = stored[CONSENT_KEY] === true;
  showStatus(
    checkbox.checked ? "Freiwillige Statistik ist eingeschaltet." : "Freiwillige Statistik ist aus.",
  );
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
