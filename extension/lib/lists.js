/*
 * The built-in distraction list packaged with the extension (extension/lists/).
 * The data files are kept apart from the blocking logic so they can be reviewed and tested on their own.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./matcher.js'));
  else root.SBLists = factory(root.SBMatcher);
})(globalThis, function (SBMatcher) {
  'use strict';

  // Every file here is merged into the one "built-in distraction list".
  const BUILTIN_FILES = ['lists/distractions.txt'];
  // Study and work essentials that a list entry may never block as a whole site.
  const NEVER_BLOCK_FILE = 'lists/never-block.txt';

  /** Reads the "# Key: value" lines at the top of a list file into { key: value } (keys lowercased). */
  function readHeader(text) {
    const meta = {};
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith('#')) break;
      const match = /^#\s*([A-Za-z-]+):\s*(.+)$/.exec(line);
      if (match) meta[match[1].toLowerCase()] = match[2].trim();
    }
    return meta;
  }

  /**
   * Loads the packaged lists. `readFile(path)` resolves to a file's text: fetch() in the
   * extension, fs in the tests. Entries on the never-block list are dropped.
   * Returns { hosts: Set, neverBlock: Set, count, listDate }.
   */
  async function loadBuiltinList(readFile) {
    const [neverBlockText, ...texts] = await Promise.all([NEVER_BLOCK_FILE, ...BUILTIN_FILES].map(readFile));
    const neverBlock = new Set(SBMatcher.parseHostList(neverBlockText));
    const hosts = new Set();
    for (const text of texts) {
      for (const host of SBMatcher.parseHostList(text)) {
        if (!neverBlock.has(host)) hosts.add(host);
      }
    }
    const meta = readHeader(texts[0]);
    return { hosts, neverBlock, count: hosts.size, listDate: meta['list-date'] || null };
  }

  return { BUILTIN_FILES, NEVER_BLOCK_FILE, readHeader, loadBuiltinList };
});
