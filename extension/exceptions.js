"use strict";

(() => {
  const PREDEFINED_KEY = "predefinedDomainExceptionsV1";
  const CUSTOM_KEY = "customDomainExceptionsV1";
  const MAX_CUSTOM_DOMAINS = 20;
  const DOMAIN_PATTERN =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

  const predefined = [
    ["facebook", "Facebook", ["facebook.com", "fb.com"], true],
    ["instagram", "Instagram", ["instagram.com"], true],
    ["x", "X (Twitter)", ["x.com", "twitter.com"], true],
    ["youtube", "YouTube", ["youtube.com", "youtu.be"], true],
    ["tiktok", "TikTok", ["tiktok.com"], true],
    ["linkedin", "LinkedIn", ["linkedin.com"], true],
    ["pinterest", "Pinterest", ["pinterest.com"], true],
    ["snapchat", "Snapchat", ["snapchat.com"], true],
    ["threads", "Threads", ["threads.net"], true],
    ["bluesky", "Bluesky", ["bsky.app"], true],
    ["mastodon", "Mastodon", ["mastodon.social"], true],
    ["tumblr", "Tumblr", ["tumblr.com"], true],
    ["twitch", "Twitch", ["twitch.tv"], true],
    ["discord", "Discord", ["discord.com", "discord.gg"], true],
    ["telegram", "Telegram", ["t.me", "telegram.org"], true],
    ["whatsapp", "WhatsApp", ["whatsapp.com", "wa.me"], true],
    ["xing", "XING", ["xing.com"], true],
    ["vk", "VK", ["vk.com"], true],
    ["wikipedia", "Wikipedia", ["wikipedia.org"], false],
    ["reddit", "Reddit", ["reddit.com"], false],
  ].map(([id, label, domains, defaultException]) =>
    Object.freeze({ id, label, domains: Object.freeze(domains), defaultException }),
  );
  const PREDEFINED = Object.freeze(predefined);
  const PREDEFINED_IDS = new Set(PREDEFINED.map(({ id }) => id));

  function normalizedLookupHostname(value) {
    if (typeof value !== "string") return null;
    const hostname = value.trim().toLowerCase().replace(/\.$/, "");
    return DOMAIN_PATTERN.test(hostname) ? hostname : null;
  }

  function domainMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }

  function predefinedRule(value) {
    const hostname = normalizedLookupHostname(value);
    if (hostname === null) return null;
    return (
      PREDEFINED.find(({ domains }) => domains.some((domain) => domainMatches(hostname, domain))) || null
    );
  }

  function sanitizePredefinedOverrides(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const sanitized = {};
    for (const [id, enabled] of Object.entries(value)) {
      if (PREDEFINED_IDS.has(id) && typeof enabled === "boolean") sanitized[id] = enabled;
    }
    return sanitized;
  }

  function predefinedEnabled(rule, overrides) {
    return typeof overrides?.[rule.id] === "boolean" ? overrides[rule.id] : rule.defaultException;
  }

  function validateCustomDomain(value) {
    if (typeof value !== "string") return { error: "Bitte nur einen Domainnamen eintragen.", valid: false };
    const raw = value.trim().toLowerCase();
    if (!raw) return { empty: true, valid: false };
    if (raw.startsWith("www.") || raw.includes("://") || /[/?#:@\\\s]/.test(raw) || raw.endsWith(".")) {
      return { error: "Nur die Domain ohne http, www, Pfad oder Port eintragen.", valid: false };
    }
    let domain;
    try {
      const parsed = new URL(`https://${raw}`);
      domain = parsed.hostname.toLowerCase();
    } catch {
      return { error: "Der Domainname ist ungültig.", valid: false };
    }
    const topLevelDomain = domain.split(".").at(-1) || "";
    if (!DOMAIN_PATTERN.test(domain) || !/[a-z]/.test(topLevelDomain)) {
      return { error: "Der Domainname ist ungültig.", valid: false };
    }
    const existingRule = predefinedRule(domain);
    if (existingRule) {
      return {
        error: `${existingRule.label} kann unter „Vordefinierte Ausnahmen“ geändert werden.`,
        valid: false,
      };
    }
    return { domain, valid: true };
  }

  function sanitizeCustomDomains(value) {
    if (!Array.isArray(value)) return [];
    const sanitized = [];
    const seen = new Set();
    for (const item of value.slice(0, 100)) {
      const result = validateCustomDomain(item);
      if (!result.valid || seen.has(result.domain)) continue;
      seen.add(result.domain);
      sanitized.push(result.domain);
      if (sanitized.length === MAX_CUSTOM_DOMAINS) break;
    }
    return sanitized;
  }

  function classifyLocalDomain(value, overrides, customDomains) {
    const hostname = normalizedLookupHostname(value);
    if (hostname === null) return null;
    if (customDomains.some((domain) => domainMatches(hostname, domain))) {
      return { domain: hostname, filterCategory: null, known: true, state: "exception" };
    }
    const rule = predefinedRule(hostname);
    if (rule === null) return null;
    return {
      domain: hostname,
      filterCategory: null,
      known: true,
      state: predefinedEnabled(rule, overrides) ? "exception" : "blocked",
    };
  }

  globalThis.SuchfilterExceptions = Object.freeze({
    CUSTOM_KEY,
    MAX_CUSTOM_DOMAINS,
    PREDEFINED,
    PREDEFINED_KEY,
    classifyLocalDomain,
    predefinedEnabled,
    sanitizeCustomDomains,
    sanitizePredefinedOverrides,
    validateCustomDomain,
  });
})();
