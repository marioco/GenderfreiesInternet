"use strict";

const {
  CUSTOM_KEY,
  MAX_CUSTOM_DOMAINS,
  PREDEFINED,
  PREDEFINED_KEY,
  predefinedEnabled,
  sanitizeCustomDomains,
  sanitizePredefinedOverrides,
  validateCustomDomain,
} = globalThis.SuchfilterExceptions;

const CONSENT_KEY = "shareAnonymousStatisticsV1";
const FILTER_LIGHT_KEY = "blockLightGenderingV1";
const PENDING_KEY = "pendingHiddenStatisticsV1";
const checkbox = document.querySelector("#share-statistics");
const filterChoices = [...document.querySelectorAll('input[name="filter-level"]')];
const filterStatusLine = document.querySelector("#filter-status");
const statusLine = document.querySelector("#settings-status");
const predefinedContainer = document.querySelector("#predefined-exceptions");
const predefinedStatusLine = document.querySelector("#predefined-status");
const customContainer = document.querySelector("#custom-exceptions");
const customForm = document.querySelector("#custom-exceptions-form");
const customStatusLine = document.querySelector("#custom-status");
const tabs = [...document.querySelectorAll('[role="tab"]')];
let predefinedOverrides = {};
let customInputs = [];

function showStatus(target, text, failed = false) {
  target.textContent = text;
  target.classList.toggle("status-error", failed);
}

function showFilterStatus(blockLight, failed = false) {
  showStatus(
    filterStatusLine,
    blockLight ? "Filter aktiv: hartes und leichtes Gendern." : "Standardfilter aktiv: nur hartes Gendern.",
    failed,
  );
}

function selectFilterLevel(blockLight) {
  for (const choice of filterChoices) {
    choice.checked = choice.value === (blockLight ? "hard-light" : "hard");
  }
}

function activateTab(selected, focus = true) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.querySelector(`#${tab.getAttribute("aria-controls")}`).hidden = !active;
  }
  if (focus) selected.focus();
}

function initializeTabs() {
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => activateTab(tab, false));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = null;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      activateTab(tabs[nextIndex]);
    });
  }
  activateTab(tabs[0], false);
}

function updatePredefinedRow(input, rule) {
  const state = input.closest(".predefined-exception-row").querySelector(".exception-state");
  state.textContent = input.checked ? "Ausnahme" : "Blockiert";
  state.className = `exception-state ${input.checked ? "is-exception" : "is-blocked"}`;
  input.setAttribute("aria-label", `${rule.label}: ${input.checked ? "als Ausnahme sichtbar" : "blockiert"}`);
}

function renderPredefinedExceptions() {
  predefinedContainer.replaceChildren();
  for (const rule of PREDEFINED) {
    const row = document.createElement("label");
    row.className = "predefined-exception-row";
    row.htmlFor = `predefined-${rule.id}`;

    const input = document.createElement("input");
    input.id = `predefined-${rule.id}`;
    input.type = "checkbox";
    input.checked = predefinedEnabled(rule, predefinedOverrides);

    const description = document.createElement("span");
    description.className = "exception-description";
    const title = document.createElement("strong");
    title.textContent = rule.label;
    const domains = document.createElement("small");
    domains.textContent = rule.domains.join(", ");
    description.append(title, domains);

    const state = document.createElement("span");
    state.className = "exception-state";
    row.append(input, description, state);
    predefinedContainer.append(row);
    updatePredefinedRow(input, rule);

    input.addEventListener("change", async () => {
      const previous = !input.checked;
      input.disabled = true;
      const next = { ...predefinedOverrides };
      if (input.checked === rule.defaultException) delete next[rule.id];
      else next[rule.id] = input.checked;
      try {
        await chrome.storage.local.set({ [PREDEFINED_KEY]: next });
        predefinedOverrides = next;
        updatePredefinedRow(input, rule);
        showStatus(predefinedStatusLine, `${rule.label} wurde gespeichert.`);
      } catch (error) {
        input.checked = previous;
        updatePredefinedRow(input, rule);
        showStatus(predefinedStatusLine, `Ausnahme konnte nicht gespeichert werden: ${error.message}`, true);
      } finally {
        input.disabled = false;
      }
    });
  }
}

function createCustomInputs() {
  customContainer.replaceChildren();
  customInputs = [];
  for (let index = 0; index < MAX_CUSTOM_DOMAINS; index += 1) {
    const row = document.createElement("label");
    row.className = "custom-exception-row";
    row.htmlFor = `custom-domain-${index + 1}`;

    const number = document.createElement("span");
    number.className = "custom-exception-number";
    number.textContent = `${index + 1}.`;

    const input = document.createElement("input");
    input.id = `custom-domain-${index + 1}`;
    input.type = "text";
    input.inputMode = "url";
    input.autocomplete = "off";
    input.placeholder = "beispiel.de";
    input.spellcheck = false;
    input.maxLength = 253;
    input.setAttribute("aria-label", `Eigene Ausnahme ${index + 1}`);

    const indicator = document.createElement("span");
    indicator.className = "domain-validation";
    indicator.setAttribute("aria-live", "polite");
    row.append(number, input, indicator);
    customContainer.append(row);
    customInputs.push(input);
    input.addEventListener("input", () => {
      validateCustomInputs();
      showStatus(customStatusLine, "Änderungen noch nicht gespeichert.");
    });
  }
}

function validateCustomInputs() {
  const results = customInputs.map((input) => validateCustomDomain(input.value));
  const counts = new Map();
  for (const result of results) {
    if (result.valid) counts.set(result.domain, (counts.get(result.domain) || 0) + 1);
  }
  let firstError = null;
  const domains = [];
  results.forEach((result, index) => {
    const input = customInputs[index];
    const indicator = input.parentElement.querySelector(".domain-validation");
    const duplicate = result.valid && counts.get(result.domain) > 1;
    const error = duplicate ? "Diese Domain wurde mehrfach eingetragen." : result.error;
    input.setCustomValidity(error || "");
    if (result.empty) {
      input.removeAttribute("aria-invalid");
      indicator.textContent = "";
      indicator.className = "domain-validation";
      indicator.removeAttribute("title");
      return;
    }
    if (result.valid && !duplicate) {
      domains.push(result.domain);
      input.setAttribute("aria-invalid", "false");
      indicator.textContent = "✓";
      indicator.className = "domain-validation valid";
      indicator.title = "Gültige Domain";
      return;
    }
    firstError ||= { input, message: error || "Der Domainname ist ungültig." };
    input.setAttribute("aria-invalid", "true");
    indicator.textContent = "✕";
    indicator.className = "domain-validation invalid";
    indicator.title = error || "Ungültige Domain";
  });
  return { domains, firstError };
}

async function initializeSettings() {
  try {
    const filterStored = await chrome.storage.local.get(FILTER_LIGHT_KEY);
    const blockLight = filterStored[FILTER_LIGHT_KEY] === true;
    selectFilterLevel(blockLight);
    showFilterStatus(blockLight);
  } catch (error) {
    selectFilterLevel(false);
    showStatus(filterStatusLine, `Filterstärke konnte nicht geladen werden: ${error.message}`, true);
  }

  try {
    const stored = await chrome.storage.local.get(CONSENT_KEY);
    checkbox.checked = stored[CONSENT_KEY] === true;
    showStatus(
      statusLine,
      checkbox.checked ? "Freiwillige Statistik ist eingeschaltet." : "Freiwillige Statistik ist aus.",
    );
  } catch (error) {
    checkbox.checked = false;
    showStatus(statusLine, `Einstellung konnte nicht geladen werden: ${error.message}`, true);
  }
}

async function initializePredefinedExceptions() {
  try {
    const stored = await chrome.storage.local.get(PREDEFINED_KEY);
    predefinedOverrides = sanitizePredefinedOverrides(stored[PREDEFINED_KEY]);
    renderPredefinedExceptions();
    showStatus(predefinedStatusLine, "Vordefinierte Ausnahmen sind aktiv.");
  } catch (error) {
    predefinedOverrides = {};
    renderPredefinedExceptions();
    showStatus(predefinedStatusLine, `Ausnahmen konnten nicht geladen werden: ${error.message}`, true);
  }
}

async function initializeCustomExceptions() {
  createCustomInputs();
  try {
    const stored = await chrome.storage.local.get(CUSTOM_KEY);
    const domains = sanitizeCustomDomains(stored[CUSTOM_KEY]);
    domains.forEach((domain, index) => {
      customInputs[index].value = domain;
    });
    validateCustomInputs();
    showStatus(customStatusLine, `${domains.length} eigene Ausnahmen gespeichert.`);
  } catch (error) {
    showStatus(customStatusLine, `Eigene Ausnahmen konnten nicht geladen werden: ${error.message}`, true);
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
      let storedValue = false;
      try {
        const stored = await chrome.storage.local.get(FILTER_LIGHT_KEY);
        storedValue = stored[FILTER_LIGHT_KEY] === true;
      } catch {
        storedValue = false;
      }
      selectFilterLevel(storedValue);
      showStatus(filterStatusLine, `Filterstärke konnte nicht gespeichert werden: ${error.message}`, true);
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
      statusLine,
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
    showStatus(statusLine, `Einstellung konnte nicht gespeichert werden: ${error.message}`, true);
  } finally {
    checkbox.disabled = false;
  }
});

customForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { domains, firstError } = validateCustomInputs();
  if (firstError) {
    firstError.input.focus();
    showStatus(customStatusLine, firstError.message, true);
    return;
  }
  const button = customForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await chrome.storage.local.set({ [CUSTOM_KEY]: domains });
    showStatus(customStatusLine, `${domains.length} eigene Ausnahmen gespeichert.`);
  } catch (error) {
    showStatus(customStatusLine, `Eigene Ausnahmen konnten nicht gespeichert werden: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  initializeTabs();
  await Promise.all([initializeSettings(), initializePredefinedExceptions(), initializeCustomExceptions()]);
}

initialize().catch((error) =>
  showStatus(statusLine, `Einstellungen konnten nicht geladen werden: ${error.message}`, true),
);
