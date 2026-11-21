"use strict";

const browserApi = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
const statusLine = document.querySelector("#pin-status");
const checkButton = document.querySelector("#check-pin");
const finishButton = document.querySelector("#finish-onboarding");
let pinCheckSequence = 0;

function isSafariBuild() {
  const manifest = browserApi.runtime?.getManifest?.();
  return Boolean(manifest?.browser_specific_settings?.safari);
}

function showSafariState() {
  statusLine.classList.remove("status-error", "pin-success");
  statusLine.textContent =
    "Öffne anschließend eine unterstützte Suchseite und erlaube GF dort beim ersten Einsatz den Zugriff.";
  checkButton.hidden = true;
  finishButton.textContent = "Einrichtung abschließen";
}

function showPinState(isPinned) {
  statusLine.classList.remove("status-error", "pin-success");
  if (isPinned) {
    statusLine.classList.add("pin-success");
    statusLine.textContent = "Fertig: Das GF-Symbol ist in der Browserleiste angeheftet.";
    checkButton.hidden = true;
    finishButton.textContent = "Einrichtung abschließen";
    return;
  }
  statusLine.textContent = "Das GF-Symbol ist noch nicht angeheftet. Das ist freiwillig.";
  checkButton.hidden = false;
  finishButton.textContent = "Ohne Anheften fortfahren";
}

async function checkPinState() {
  const sequence = ++pinCheckSequence;
  checkButton.disabled = true;
  statusLine.classList.remove("status-error", "pin-success");
  try {
    if (!browserApi.action?.getUserSettings) {
      statusLine.classList.add("status-error");
      statusLine.textContent =
        "Der Browser kann den Zustand nicht melden. Bitte das Symbol nach der Anleitung anheften.";
      return;
    }
    const settings = await browserApi.action.getUserSettings();
    if (sequence !== pinCheckSequence) return;
    showPinState(settings?.isOnToolbar === true);
  } catch (error) {
    if (sequence !== pinCheckSequence) return;
    statusLine.classList.add("status-error");
    statusLine.textContent = `Der Zustand konnte nicht geprüft werden: ${error.message}`;
  } finally {
    if (sequence === pinCheckSequence) checkButton.disabled = false;
  }
}

async function finishOnboarding() {
  finishButton.disabled = true;
  try {
    const currentTab = await browserApi.tabs?.getCurrent?.();
    if (currentTab?.id !== undefined && browserApi.tabs?.remove) {
      await browserApi.tabs.remove(currentTab.id);
      return;
    }
    window.close();
    statusLine.textContent = "Einrichtung abgeschlossen. Dieser Tab kann geschlossen werden.";
  } catch (error) {
    statusLine.classList.remove("pin-success");
    statusLine.classList.add("status-error");
    statusLine.textContent = `Dieser Tab konnte nicht geschlossen werden: ${error.message}`;
    finishButton.disabled = false;
  }
}

checkButton.addEventListener("click", checkPinState);
finishButton.addEventListener("click", finishOnboarding);
if (isSafariBuild()) {
  showSafariState();
} else {
  window.addEventListener("focus", checkPinState);
  checkPinState();
}
