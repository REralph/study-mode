/*
 * URL matching rules. Pure functions with no browser APIs, shared by the background
 * script, the extension pages and the Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SBMatcher = factory();
})(globalThis, function () {
  'use strict';

  const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
  const HOST_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

  // Placeholder names found in hosts-format lists; they are never real block targets.
  const HOSTS_FILE_PLACEHOLDERS = new Set([
    'localhost', 'localhost.localdomain', 'local', 'broadcasthost',
    'ip6-localhost', 'ip6-loopback', '0.0.0.0', '127.0.0.1',
  ]);

  // Where each search engine keeps the query text.
  const SEARCH_ENGINES = [
    { name: 'Google', host: /^google\.(?:com|[a-z]{2}|com?\.[a-z]{2})$/, params: ['q'] },
    { name: 'Bing', host: /^(?:[a-z]{2}\.)?bing\.com$/, params: ['q'] },
    { name: 'DuckDuckGo', host: /^(?:html\.|lite\.)?duckduckgo\.com$/, params: ['q'] },
    { name: 'Yahoo', host: /^(?:[a-z]{2}\.)?search\.yahoo\.com$/, params: ['p', 'q'] },
    { name: 'YouTube', host: /^(?:m\.)?youtube\.com$/, path: /^\/results/, params: ['search_query'] },
    { name: 'Brave Search', host: /^search\.brave\.com$/, params: ['q'] },
    { name: 'Ecosia', host: /^ecosia\.org$/, params: ['q'] },
    { name: 'Startpage', host: /^startpage\.com$/, params: ['query', 'q'] },
    { name: 'Yandex', host: /^yandex\.(?:com|ru|com\.tr|kz|by)$/, params: ['text'] },
    { name: 'Reddit', host: /^(?:old\.|new\.)?reddit\.com$/, params: ['q'] },
    { name: 'X', host: /^(?:x|twitter)\.com$/, params: ['q'] },
  ];

  /** Lowercases, drops a trailing dot and a leading "www." so www.example.com == example.com. */
  function normalizeHost(host) {
    let h = String(host || '').trim().toLowerCase().replace(/\.+$/, '');
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  }

  function normalizePath(path) {
    if (!path) return '';
    try {
      return new URL(path, 'http://x').pathname.toLowerCase().replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  /**
   * Parses one rule. Accepts "example.com", full URLs, "*.example.com", hosts-file lines
   * ("0.0.0.0 example.com") and adblock rules ("||example.com^"). A path such as
   * "reddit.com/r/name" limits the rule to that section of the site.
   * Returns { host, path } with path '' for whole-site rules, or null if unusable.
   */
  function parseEntry(raw) {
    let s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s || s.startsWith('#') || s.startsWith('!')) return null;
    s = s.replace(/\s+#.*$/, '');
    const hostsLine = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)/.exec(s);
    if (hostsLine) s = hostsLine[1];
    else if (/\s/.test(s)) return null;
    s = s.replace(/^\|\|/, '').replace(/\^.*$/, '')
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^\*?\./, '');
    const cut = s.search(/[/?#]/);
    const hostPart = cut === -1 ? s : s.slice(0, cut);
    const pathPart = cut === -1 ? '' : s.slice(cut).replace(/[?#].*$/, '');
    const host = normalizeHost(hostPart.replace(/^[^@]*@/, '').replace(/:\d*$/, ''));
    if (!HOST_RE.test(host)) return null;
    return { host, path: normalizePath(pathPart) };
  }

  function formatEntry(entry) {
    return entry.host + entry.path;
  }

  /** Cleans rule lines typed by the user: canonical form, no duplicates, unusable lines reported. */
  function normalizeRuleList(lines) {
    const valid = [];
    const invalid = [];
    const seen = new Set();
    for (const line of lines) {
      const trimmed = String(line).trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const entry = parseEntry(trimmed);
      if (!entry) {
        invalid.push(trimmed);
        continue;
      }
      const key = formatEntry(entry);
      if (!seen.has(key)) {
        seen.add(key);
        valid.push(key);
      }
    }
    return { valid, invalid };
  }

  /** Extracts bare domains from a list file (hosts file, plain domains or adblock rules). */
  function parseHostList(text) {
    const hosts = new Set();
    for (const line of String(text).split(/\r?\n/)) {
      const entry = parseEntry(line);
      if (entry && !entry.path && !HOSTS_FILE_PLACEHOLDERS.has(entry.host)) hosts.add(entry.host);
    }
    return [...hosts];
  }

  function createRuleSet(entries) {
    const hosts = new Set();
    const paths = new Map(); // host -> path prefixes
    for (const item of entries || []) {
      const entry = typeof item === 'string' ? parseEntry(item) : item;
      if (!entry) continue;
      if (!entry.path) hosts.add(entry.host);
      else if (paths.has(entry.host)) paths.get(entry.host).push(entry.path);
      else paths.set(entry.host, [entry.path]);
    }
    return { hosts, paths };
  }

  /** Returns the most specific entry covering `host`: the host itself, else its closest parent domain. */
  function findDomain(host, set) {
    if (!set.size) return null;
    for (let h = host; ;) {
      if (set.has(h)) return h;
      const dot = h.indexOf('.');
      if (dot === -1) return null;
      h = h.slice(dot + 1);
    }
  }

  /** Like findDomain for "host/path" rules; "/r/name" covers "/r/name/..." but not "/r/names". */
  function findPathRule(host, pathname, paths) {
    if (!paths.size) return null;
    for (let h = host; ;) {
      const prefixes = paths.get(h);
      if (prefixes) {
        for (const prefix of prefixes) {
          if (pathname === prefix || pathname.startsWith(prefix + '/')) return h + prefix;
        }
      }
      const dot = h.indexOf('.');
      if (dot === -1) return null;
      h = h.slice(dot + 1);
    }
  }

  function findRule(host, pathname, ruleSet) {
    return findPathRule(host, pathname, ruleSet.paths) || findDomain(host, ruleSet.hosts);
  }

  /**
   * How specific a matched rule is: more domain labels first, then more path segments.
   * "a.example.com" (3 labels) beats "example.com" (2); "example.com/r/x" beats "example.com".
   */
  function specificity(rule) {
    const slash = rule.indexOf('/');
    const host = slash === -1 ? rule : rule.slice(0, slash);
    const segments = slash === -1 ? 0 : rule.slice(slash).split('/').length - 1;
    return host.split('.').length * 1000 + segments;
  }

  function findKeyword(text, keywords) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) return keyword;
    }
    return null;
  }

  /** Returns { engine, query } when `url` is a search results page, else null. */
  function getSearchQuery(url) {
    const host = normalizeHost(url.hostname);
    const engine = SEARCH_ENGINES.find((e) => e.host.test(host) && (!e.path || e.path.test(url.pathname)));
    if (!engine) return null;
    for (const param of engine.params) {
      const query = url.searchParams.get(param);
      if (query) return { engine: engine.name, query };
    }
    return null;
  }

  /**
   * Builds a matcher from the current settings.
   * config.lists: [{ id, hosts }] domain lists; customBlock / allow: rule strings;
   * keywords with the keywordBlocking / searchBlocking switches.
   */
  function createMatcher(config) {
    const lists = (config.lists || []).map((list) => ({
      id: list.id,
      hosts: list.hosts instanceof Set ? list.hosts : new Set(list.hosts),
    }));
    const custom = createRuleSet(config.customBlock);
    const allow = createRuleSet(config.allow);
    const keywords = [...new Set((config.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
    const keywordBlocking = Boolean(config.keywordBlocking) && keywords.length > 0;
    const searchBlocking = Boolean(config.searchBlocking) && keywords.length > 0;

    /** The most specific block entry covering the address, from your list or any domain list. */
    function findBlock(host, pathname) {
      const own = findRule(host, pathname, custom);
      let best = own ? { reason: 'custom', rule: own } : null;
      for (const list of lists) {
        const rule = findDomain(host, list.hosts);
        // Strictly greater: on a tie your own entry is kept, because it also wins ties with exceptions.
        if (rule && (!best || specificity(rule) > specificity(best.rule))) best = { reason: 'list', list: list.id, rule };
      }
      return best;
    }

    /**
     * Returns null when the URL may load, otherwise a verdict
     * { reason: 'custom' | 'list' | 'keyword' | 'search', rule, host, list?, engine? }.
     * Search queries are only checked when opts.mainFrame is true (a top-level navigation).
     *
     * Priority between block entries and exceptions:
     *  1. The most specific matching entry wins (see specificity()), whichever list it is on.
     *  2. On an exact tie, your own block entry beats an exception, and an exception beats
     *     a built-in list entry.
     *  3. Any matching exception also turns off keyword matching in the site address.
     *     Search queries are checked regardless of exceptions.
     */
    function check(rawUrl, opts) {
      let url;
      try {
        url = new URL(rawUrl);
      } catch {
        return null;
      }
      if (!WEB_PROTOCOLS.has(url.protocol)) return null;
      const host = normalizeHost(url.hostname);
      if (!host) return null;
      const pathname = url.pathname.toLowerCase();

      const block = findBlock(host, pathname);
      const allowRule = findRule(host, pathname, allow);
      if (block) {
        const lead = allowRule ? specificity(block.rule) - specificity(allowRule) : 1;
        if (lead > 0 || (lead === 0 && block.reason === 'custom')) return { ...block, host };
      }

      if (!allowRule && keywordBlocking) {
        const rule = findKeyword(host, keywords);
        if (rule) return { reason: 'keyword', rule, host };
      }

      if (searchBlocking && opts && opts.mainFrame) {
        const search = getSearchQuery(url);
        if (search) {
          const rule = findKeyword(search.query.toLowerCase(), keywords);
          if (rule) return { reason: 'search', rule, host, engine: search.engine };
        }
      }
      return null;
    }

    return { check };
  }

  return {
    SEARCH_ENGINES,
    normalizeHost,
    parseEntry,
    formatEntry,
    normalizeRuleList,
    parseHostList,
    createRuleSet,
    findDomain,
    specificity,
    findKeyword,
    getSearchQuery,
    createMatcher,
  };
});
