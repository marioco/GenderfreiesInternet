"use strict";

import {
  applyProofs,
  lookupCached,
  SnapshotError,
  sanitizeCache,
  verifyEnvelope,
  verifySignedPayload,
} from "./snapshot.js";

const SHARD_COUNT = 64;
const MAX_SHARD_ENTRIES = 100000;
const SHARD_KEY_PREFIX = "signedDatasetShardV1:";
const ACTIVE_SHARDS_KEY = "signedDatasetActiveShardsV1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_PATTERN = /^(?:snapshot|delta)-[A-Za-z0-9._-]{1,160}\.json$/;
const FETCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_FETCHES = 4;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validFile(item) {
  return (
    exactKeys(item, ["count", "file", "sha256", "shard"]) &&
    Number.isSafeInteger(item.shard) &&
    item.shard >= 0 &&
    item.shard < SHARD_COUNT &&
    Number.isSafeInteger(item.count) &&
    item.count >= 0 &&
    item.count <= MAX_SHARD_ENTRIES &&
    typeof item.file === "string" &&
    FILE_PATTERN.test(item.file) &&
    typeof item.sha256 === "string" &&
    SHA256_PATTERN.test(item.sha256)
  );
}

function validateFiles(files, { complete }) {
  if (!Array.isArray(files) || files.length > SHARD_COUNT) throw new SnapshotError("Dateiliste ist ungültig");
  const shards = new Set();
  for (const item of files) {
    if (!validFile(item) || shards.has(item.shard)) throw new SnapshotError("Datendatei ist ungültig");
    shards.add(item.shard);
  }
  if (complete && (files.length !== SHARD_COUNT || shards.size !== SHARD_COUNT)) {
    throw new SnapshotError("Snapshot ist unvollständig");
  }
}

export async function verifyDatasetManifest(envelope, publicKeys, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new SnapshotError("Vergleichszeit ist ungültig");
  }
  const payload = await verifySignedPayload(envelope, publicKeys);
  if (
    !exactKeys(payload, [
      "dataset_schema_version",
      "deltas",
      "expires_at",
      "generated_at",
      "schema_version",
      "shard_count",
      "snapshot_version",
      "snapshots",
      "version",
    ]) ||
    payload.schema_version !== 1 ||
    payload.dataset_schema_version !== 1 ||
    payload.shard_count !== SHARD_COUNT ||
    !Number.isSafeInteger(payload.snapshot_version) ||
    payload.snapshot_version < 0 ||
    !Number.isSafeInteger(payload.version) ||
    payload.version < payload.snapshot_version
  ) {
    throw new SnapshotError("Datenmanifest besitzt ein ungültiges Schema");
  }
  const generated = Date.parse(payload.generated_at);
  const expires = Date.parse(payload.expires_at);
  if (
    typeof payload.generated_at !== "string" ||
    typeof payload.expires_at !== "string" ||
    !Number.isFinite(generated) ||
    !Number.isFinite(expires) ||
    generated > now.getTime() + 300000 ||
    expires <= now.getTime() ||
    expires <= generated ||
    expires > generated + 7 * 86400000 + 300000
  ) {
    throw new SnapshotError("Datenmanifest ist zeitlich ungültig");
  }
  validateFiles(payload.snapshots, { complete: true });
  if (!Array.isArray(payload.deltas) || payload.deltas.length > 1000) {
    throw new SnapshotError("Deltakette ist ungültig");
  }
  let expectedVersion = payload.snapshot_version;
  for (const delta of payload.deltas) {
    if (
      !exactKeys(delta, ["base_version", "files", "version"]) ||
      delta.base_version !== expectedVersion ||
      !Number.isSafeInteger(delta.version) ||
      delta.version <= delta.base_version ||
      delta.version > payload.version
    ) {
      throw new SnapshotError("Deltakette ist nicht lückenlos");
    }
    validateFiles(delta.files, { complete: false });
    expectedVersion = delta.version;
  }
  if (expectedVersion !== payload.version) throw new SnapshotError("Deltakette endet am falschen Stand");
  return payload;
}

function hostnameCandidates(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!DOMAIN_PATTERN.test(host)) return [];
  const labels = host.split(".");
  return labels.slice(0, -1).map((_label, index) => labels.slice(index).join("."));
}

export async function datasetShard(domain) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain));
  return new Uint8Array(digest)[0] >> 2;
}

function shardKey(shard) {
  return `${SHARD_KEY_PREFIX}${String(shard).padStart(2, "0")}`;
}

async function responseBytes(response, context) {
  if (!response.ok) throw new Error(`${context} fehlgeschlagen (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fetchDatasetResource(url, context) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`${context} hat das Zeitlimit überschritten`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDataFile(baseUrl, descriptor, publicKeys, expectedBase, expectedVersion, shard) {
  const response = await fetchDatasetResource(new URL(descriptor.file, baseUrl), "Datenaktualisierung");
  const bytes = await responseBytes(response, "Datenaktualisierung");
  if ((await sha256Hex(bytes)) !== descriptor.sha256) throw new SnapshotError("Datendatei ist beschädigt");
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new SnapshotError("Datendatei ist kein gültiges JSON", { cause: error });
  }
  const payload = await verifyEnvelope(envelope, publicKeys);
  if (payload.base_version !== expectedBase || payload.version !== expectedVersion) {
    throw new SnapshotError("Datendatei gehört zu einem anderen Stand");
  }
  if (payload.changes.length !== descriptor.count) throw new SnapshotError("Datendateizähler stimmt nicht");
  for (const change of payload.changes) {
    if ((await datasetShard(change.domain)) !== shard)
      throw new SnapshotError("Domain liegt im falschen Paket");
  }
  return payload;
}

async function updateShard(shard, manifest, baseUrl, publicKeys) {
  const key = shardKey(shard);
  const stored = await chrome.storage.local.get(key);
  const raw = stored[key];
  let cache = sanitizeCache(raw?.cache, new Date(), MAX_SHARD_ENTRIES);
  let version = Number.isSafeInteger(raw?.version) ? raw.version : -1;
  const snapshot = manifest.snapshots.find((item) => item.shard === shard);
  if (!snapshot) throw new SnapshotError("Snapshot-Paket fehlt");
  if (
    raw?.snapshotFile !== snapshot.file ||
    version < manifest.snapshot_version ||
    cache.latestProofExpiresAt === null
  ) {
    const payload = await fetchDataFile(baseUrl, snapshot, publicKeys, 0, manifest.snapshot_version, shard);
    cache = applyProofs({ entries: {}, latestProofVersion: 0 }, payload, new Date(), MAX_SHARD_ENTRIES);
    version = manifest.snapshot_version;
  }
  for (const delta of manifest.deltas) {
    if (delta.version <= version) continue;
    if (delta.base_version !== version) throw new SnapshotError("Lokaler Datenstand hat eine Lücke");
    const descriptor = delta.files.find((item) => item.shard === shard);
    if (descriptor) {
      const payload = await fetchDataFile(
        baseUrl,
        descriptor,
        publicKeys,
        delta.base_version,
        delta.version,
        shard,
      );
      cache = applyProofs(cache, payload, new Date(), MAX_SHARD_ENTRIES);
    }
    version = delta.version;
  }
  if (version !== manifest.version) throw new SnapshotError("Paketstand ist nicht aktuell");
  const wrapper = { cache, snapshotFile: snapshot.file, version };
  await chrome.storage.local.set({ [key]: wrapper });
  return wrapper;
}

async function requestedShards(hostnames) {
  const candidates = [...new Set(hostnames.flatMap(hostnameCandidates))];
  const pairs = await Promise.all(candidates.map(async (domain) => [domain, await datasetShard(domain)]));
  return { pairs, shards: [...new Set(pairs.map(([_domain, shard]) => shard))].sort((a, b) => a - b) };
}

async function activeShards(requested) {
  const stored = await chrome.storage.local.get(ACTIVE_SHARDS_KEY);
  const previous = Array.isArray(stored[ACTIVE_SHARDS_KEY])
    ? stored[ACTIVE_SHARDS_KEY].filter(
        (value) => Number.isSafeInteger(value) && value >= 0 && value < SHARD_COUNT,
      )
    : [];
  const combined = [...new Set([...previous, ...requested])].sort((left, right) => left - right);
  await chrome.storage.local.set({ [ACTIVE_SHARDS_KEY]: combined });
  return combined;
}

async function fetchManifest(config) {
  const response = await fetchDatasetResource(config.datasetManifestUrl, "Datenmanifest");
  if (!response.ok) throw new Error(`Datenmanifest fehlgeschlagen (${response.status})`);
  return verifyDatasetManifest(await response.json(), config.publicKeys);
}

async function mapWithBoundedConcurrency(items, worker) {
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, MAX_CONCURRENT_FETCHES) }, () => run()));
}

export async function lookupDataset(hostnames, config) {
  if (typeof config?.datasetManifestUrl !== "string") throw new Error("Datenmanifest fehlt");
  const manifest = await fetchManifest(config);
  const requested = await requestedShards(hostnames);
  const shards = hostnames.length ? requested.shards : await activeShards([]);
  if (hostnames.length) await activeShards(shards);
  const wrappers = new Map();
  await mapWithBoundedConcurrency(shards, async (shard) => {
    wrappers.set(shard, await updateShard(shard, manifest, config.datasetManifestUrl, config.publicKeys));
  });
  const entries = {};
  for (const [domain, shard] of requested.pairs) {
    const entry = wrappers.get(shard)?.cache?.entries?.[domain];
    if (entry) entries[domain] = entry;
  }
  return hostnames.map((hostname) => lookupCached(hostname, { entries }));
}

export async function lookupDatasetCached(hostnames) {
  const requested = await requestedShards(hostnames);
  const stored = await chrome.storage.local.get(requested.shards.map(shardKey));
  const entries = {};
  for (const [domain, shard] of requested.pairs) {
    const wrapper = stored[shardKey(shard)];
    const cache = sanitizeCache(wrapper?.cache, new Date(), MAX_SHARD_ENTRIES);
    const entry = cache.entries?.[domain];
    if (entry) entries[domain] = entry;
  }
  return hostnames.map((hostname) => lookupCached(hostname, { entries }));
}

export async function datasetCachedDomainCount() {
  const stored = await chrome.storage.local.get(null);
  let total = 0;
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(SHARD_KEY_PREFIX) && value?.cache?.entries) {
      total += Object.keys(value.cache.entries).length;
    }
  }
  return total;
}
