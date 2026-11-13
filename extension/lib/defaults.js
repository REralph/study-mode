/*
 * Default settings. The built-in distraction list lives in extension/lists/ (see lib/lists.js).
 * Loaded as a plain script by the extension and as a CommonJS module by the Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SBDefaults = factory();
})(globalThis, function () {
  'use strict';

  // Matched as substrings of site addresses and of search queries, so mirror sites such as
  // "tiktok-viewer.example" and searches such as "tiktok trends" are caught too. Kept short on
  // purpose: common words would also block innocent sites.
  const DEFAULT_KEYWORDS = ['tiktok', 'instagram', 'snapchat'];

  const DEFAULT_SETTINGS = {
    enabled: true,
    useBuiltinList: true,
    keywordBlocking: true,
    searchBlocking: true,
    customBlock: [],
    allow: [],
    keywords: DEFAULT_KEYWORDS,
  };

  return { DEFAULT_KEYWORDS, DEFAULT_SETTINGS };
});
