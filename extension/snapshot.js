"use strict";

const VALID_STATES = new Set(["blocked", "verified", "exception", null]);
const VALID_FILTER_CATEGORIES = new Set(["hard", "light"]);
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_PROOF_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class SnapshotError extends Error {}

function base64urlBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SnapshotError("Ungültige Base64url-Daten");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new SnapshotError("Ungültige Base64url-Daten", { cause: error });
  }
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new SnapshotError("Nur sichere Ganzzahlen sind erlaubt");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  throw new SnapshotError("Nicht kanonisierbarer Wert");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
  );
}

export async function verifySignedPayload(envelope, publicKeys) {
  if (!exactKeys(envelope, ["algorithm", "key_id", "payload", "signature"])) {
    throw new SnapshotError("Signaturhülle besitzt ein ungültiges Schema");
  }
  const encodedKey =
    typeof envelope.key_id === "string" &&
    KEY_ID_PATTERN.test(envelope.key_id) &&
    publicKeys &&
    typeof publicKeys === "object" &&
    Object.hasOwn(publicKeys, envelope.key_id)
      ? publicKeys[envelope.key_id]
      : undefined;
  if (envelope.algorithm !== "Ed25519" || typeof encodedKey !== "string") {
    throw new SnapshotError("Unbekannter Signaturschlüssel");
  }
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SnapshotError("Signaturnutzlast fehlt");
  }
  const keyBytes = base64urlBytes(encodedKey);
  const signatureBytes = base64urlBytes(envelope.signature);
  if (keyBytes.length !== 32 || signatureBytes.length !== 64) {
    throw new SnapshotError("Signaturschlüssel oder Signatur besitzt eine ungültige Länge");
  }
  let valid;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      new TextEncoder().encode(canonical(payload)),
    );
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("Signatur konnte nicht geprüft werden", { cause: error });
  }
  if (!valid) throw new SnapshotError("Signatur ist ungültig");
  return payload;
}

export async function verifyEnvelope(envelope, publicKeys, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new SnapshotError("Vergleichszeit ist ungültig");
  }
  const payload = await verifySignedPayload(envelope, publicKeys);
  if (
    !exactKeys(payload, [
      "base_version",
      "changes",
      "expires_at",
      "generated_at",
      "schema_version",
      "version",
    ])
  ) {
    throw new SnapshotError("Signaturnutzlast besitzt ein ungültiges Schema");
  }
  if (
    ![1, 2].includes(payload.schema_version) ||
    !Number.isSafeInteger(payload.version) ||
    payload.version < 0 ||
    !Number.isSafeInteger(payload.base_version) ||
    payload.base_version < 0 ||
    payload.base_version > payload.version ||
    !Array.isArray(payload.changes)
  ) {
    throw new SnapshotError("Signaturnutzlast enthält ungültige Versionen");
  }
  if (payload.changes.length > 100000) throw new SnapshotError("Signaturnutzlast ist zu groß");
  if (typeof payload.expires_at !== "string" || typeof payload.generated_at !== "string") {
    throw new SnapshotError("Signaturzeit ist ungültig");
  }
  const expires = Date.parse(payload.expires_at);
  const generated = Date.parse(payload.generated_at);
  if (
    !Number.isFinite(expires) ||
    !Number.isFinite(generated) ||
    expires <= now.getTime() ||
    expires <= generated ||
    generated > now.getTime() + 300000
  ) {
    throw new SnapshotError("Signaturnutzlast ist abgelaufen oder aus der Zukunft");
  }
  const seen = new Set();
  const changeKeys =
    payload.schema_version === 2
      ? ["domain", "expires_at", "filter_category", "state", "version"]
      : ["domain", "expires_at", "state", "version"];
  for (const change of payload.changes) {
    const filterCategory =
      payload.schema_version === 2 ? change.filter_category : change.state === "blocked" ? "hard" : null;
    if (
      !exactKeys(change, changeKeys) ||
      typeof change.domain !== "string" ||
      !DOMAIN_PATTERN.test(change.domain) ||
      seen.has(change.domain) ||
      !VALID_STATES.has(change.state) ||
      (change.state === "blocked" && !VALID_FILTER_CATEGORIES.has(filterCategory)) ||
      (change.state !== "blocked" && filterCategory !== null) ||
      !Number.isSafeInteger(change.version) ||
      change.version < 0 ||
      change.version > payload.version ||
      (change.expires_at !== null &&
        (typeof change.expires_at !== "string" || !Number.isFinite(Date.parse(change.expires_at)))) ||
      (["blocked", "verified"].includes(change.state) &&
        (change.expires_at === null || Date.parse(change.expires_at) <= generated)) ||
      (!["blocked", "verified"].includes(change.state) && change.expires_at !== null)
    ) {
      throw new SnapshotError("Domainänderung ist ungültig");
    }
    seen.add(change.domain);
  }
  return payload;
}

export function sanitizeCache(cache, now = new Date(), maximumEntries = 10000) {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 100000) {
    throw new SnapshotError("Cachegrenze ist ungültig");
  }
  const candidates = [];
  const rawEntries = cache?.entries;
  if (rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries)) {
    for (const [domain, entry] of Object.entries(rawEntries)) {
      const filterCategory = entry?.filterCategory ?? (entry?.state === "blocked" ? "hard" : null);
      if (
        !DOMAIN_PATTERN.test(domain) ||
        !entry ||
        typeof entry !== "object" ||
        !VALID_STATES.has(entry.state) ||
        (entry.state === "blocked" && !VALID_FILTER_CATEGORIES.has(filterCategory)) ||
        (entry.state !== "blocked" && filterCategory !== null) ||
        !Number.isSafeInteger(entry.stateVersion) ||
        entry.stateVersion < 0 ||
        !Number.isSafeInteger(entry.proofVersion) ||
        entry.proofVersion < 0 ||
        typeof entry.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(entry.expiresAt)) ||
        Date.parse(entry.expiresAt) <= now.getTime() ||
        typeof entry.verifiedAt !== "string" ||
        !Number.isFinite(Date.parse(entry.verifiedAt)) ||
        Date.parse(entry.verifiedAt) > now.getTime() + 300000
      ) {
        continue;
      }
      candidates.push([
        domain,
        {
          state: entry.state,
          filterCategory,
          stateVersion: entry.stateVersion,
          proofVersion: entry.proofVersion,
          expiresAt: entry.expiresAt,
          verifiedAt: entry.verifiedAt,
        },
      ]);
    }
  }
  candidates.sort(
    ([leftDomain, left], [rightDomain, right]) =>
      Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt) || leftDomain.localeCompare(rightDomain),
  );
  const entries = Object.fromEntries(candidates.slice(0, maximumEntries));
  const highestProof = candidates.reduce(
    (current, [_domain, entry]) => Math.max(current, entry.proofVersion),
    0,
  );
  const rawProofVersion = cache?.latestProofVersion;
  const rawProofExpiresAt = cache?.latestProofExpiresAt;
  const rawProofVerifiedAt = cache?.latestProofVerifiedAt;
  const proofExpires = Date.parse(rawProofExpiresAt);
  const proofVerified = Date.parse(rawProofVerifiedAt);
  const validWatermark =
    Number.isSafeInteger(rawProofVersion) &&
    rawProofVersion >= highestProof &&
    typeof rawProofExpiresAt === "string" &&
    Number.isFinite(proofExpires) &&
    proofExpires > now.getTime() &&
    typeof rawProofVerifiedAt === "string" &&
    Number.isFinite(proofVerified) &&
    proofVerified <= now.getTime() + MAX_CLOCK_SKEW_MS &&
    proofExpires > proofVerified &&
    proofExpires <= proofVerified + MAX_PROOF_LIFETIME_MS + MAX_CLOCK_SKEW_MS;
  if (validWatermark) {
    return {
      entries,
      latestProofVersion: rawProofVersion,
      latestProofExpiresAt: rawProofExpiresAt,
      latestProofVerifiedAt: rawProofVerifiedAt,
    };
  }
  const newest = candidates
    .filter(([_domain, entry]) => entry.proofVersion === highestProof)
    .sort(
      ([_leftDomain, left], [_rightDomain, right]) =>
        Date.parse(right.expiresAt) - Date.parse(left.expiresAt),
    )[0];
  return {
    entries,
    latestProofVersion: highestProof,
    latestProofExpiresAt: newest?.[1].expiresAt || null,
    latestProofVerifiedAt: newest?.[1].verifiedAt || null,
  };
}

export function applyProofs(cache, payload, now = new Date(), maximumEntries = 10000) {
  if (payload.version < (cache.latestProofVersion || 0)) return cache;
  const entries = { ...(cache.entries || {}) };
  const proofExpiresAt = payload.expires_at;
  for (const change of payload.changes) {
    const previous = entries[change.domain];
    if (previous && (previous.proofVersion > payload.version || previous.stateVersion > change.version)) {
      continue;
    }
    const stateExpiresAt = change.expires_at;
    const expiresAt =
      stateExpiresAt === null || Date.parse(proofExpiresAt) < Date.parse(stateExpiresAt)
        ? proofExpiresAt
        : stateExpiresAt;
    if (Date.parse(expiresAt) <= now.getTime()) {
      delete entries[change.domain];
      continue;
    }
    entries[change.domain] = {
      state: change.state,
      filterCategory: change.filter_category ?? (change.state === "blocked" ? "hard" : null),
      stateVersion: change.version,
      proofVersion: payload.version,
      expiresAt,
      verifiedAt: now.toISOString(),
    };
  }
  return sanitizeCache(
    {
      entries,
      latestProofVersion: Math.max(cache.latestProofVersion || 0, payload.version),
      latestProofExpiresAt: payload.expires_at,
      latestProofVerifiedAt: now.toISOString(),
    },
    now,
    maximumEntries,
  );
}

export function lookupCached(hostname, cache, now = new Date()) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!DOMAIN_PATTERN.test(host))
    return { domain: host, state: null, filterCategory: null, known: false, cached: false };
  const labels = host.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join(".");
    const entry = cache.entries?.[candidate];
    if (!entry) continue;
    if (entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now.getTime()) continue;
    return {
      domain: candidate,
      state: entry.state,
      filterCategory: entry.filterCategory,
      known: entry.state !== null,
      cached: true,
    };
  }
  return { domain: host, state: null, filterCategory: null, known: false, cached: false };
}
