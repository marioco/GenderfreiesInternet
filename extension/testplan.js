"use strict";

const CASES = [
  {
    domain: "zdfheute.de",
    category: "hart",
    after: "ausgeblendet",
    title: "Proteste wie in Frankreich? Jugendliche werden ignoriert",
    url: "https://www.zdfheute.de/politik/deutschland/proteste-jugendliche-frankreich-deutschland-soezer-100.html",
    news: true,
  },
  {
    domain: "fr.de",
    category: "hart",
    after: "ausgeblendet",
    title: "Was die Bundeswehr an Schulen macht",
    url: "https://www.fr.de/frankfurt/was-die-bundeswehr-an-schulen-macht-94511260.html",
    news: true,
  },
  {
    domain: "taz.de",
    category: "hart",
    after: "ausgeblendet",
    title: "Live-Ticker: GenZ-regelt",
    url: "https://taz.de/Live-Ticker-GenZ-regelt/%216226335/",
    news: true,
  },
  {
    domain: "news4teachers.de",
    category: "hart",
    after: "ausgeblendet",
    title: "Bundesschülerkonferenz distanziert sich vom Aufruf zu Schülerprotesten",
    url: "https://www.news4teachers.de/2026/10/bundesschuelerkonferenz-distanziert-sich-vom-aufruf-zu-schuelerprotesten-undurchsichtig/",
    news: true,
  },
  {
    domain: "fzs.de",
    category: "hart",
    after: "ausgeblendet",
    title: "BAföG-Novelle im Bundestag: Kritik ignoriert, Verbesserungen verschleppt",
    url: "https://www.fzs.de/2026/10/15/bafoeg-novelle-im-bundestag-kritik-ignoriert-verbesserungen-verschleppt-verschlechterungen-durchgedrueckt/",
    news: true,
  },
  {
    domain: "tagesschau.de",
    category: "leicht",
    after: "ausgeblendet",
    title: "Studierende blockierten Otto-Suhr-Institut an der FU Berlin",
    url: "https://www.tagesschau.de/inland/regional/berlin/rbb-studierende-blockieren-otto-suhr-institut-an-der-fu-berlin-102.html",
    news: true,
  },
  {
    domain: "deutschlandfunk.de",
    category: "leicht",
    after: "ausgeblendet",
    title: "Zahl der Studierenden an deutschen Hochschulen nimmt leicht zu",
    url: "https://www.deutschlandfunk.de/zahl-der-studierenden-an-deutschen-hochschulen-nimmt-leicht-zu-100.html",
    news: true,
  },
  {
    domain: "iana.org",
    category: "geprüft",
    after: "grüner Stern",
    title: "IANA-managed Reserved Domains",
    query: 'site:iana.org "IANA-managed Reserved Domains"',
    url: "https://www.iana.org/domains/reserved",
    news: false,
  },
  {
    domain: "x.com",
    category: "Ausnahme",
    after: "grüner Stern",
    title: "X",
    query: "site:x.com",
    url: "https://x.com/",
    news: false,
  },
  {
    domain: "amazon.de",
    category: "Ausnahme",
    after: "grüner Stern",
    title: "Amazon.de",
    query: "site:amazon.de",
    url: "https://www.amazon.de/",
    news: false,
  },
];

const ENGINES = [
  ["Google", (query) => `https://www.google.de/search?q=${encodeURIComponent(query)}`],
  ["Bing", (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`],
  ["Brave", (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`],
  ["DuckDuckGo", (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`],
];

function link(label, href, className = "") {
  const anchor = document.createElement("a");
  anchor.textContent = label;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.className = className;
  return anchor;
}

const container = document.querySelector("#tests");
for (const [index, item] of CASES.entries()) {
  const article = document.createElement("article");
  article.className = "test";
  const heading = document.createElement("h2");
  heading.textContent = `${index + 1}. ${item.domain} – ${item.title}`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${item.category}; nachher: ${item.after}`;
  const links = document.createElement("div");
  links.className = "links";
  links.append(link("Seite", item.url, "direct"));
  const searchQuery = item.query || `"${item.title}"`;
  for (const [name, makeUrl] of ENGINES) links.append(link(name, makeUrl(searchQuery)));
  if (item.news) {
    const query = encodeURIComponent(`"${item.title}"`);
    links.append(link("Google News", `https://news.google.com/search?q=${query}&hl=de&gl=DE&ceid=DE%3Ade`));
  }
  article.append(heading, meta, links);
  container.append(article);
}
