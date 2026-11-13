'use strict';

const $ = (id) => document.getElementById(id);

const LIST_NAMES = {
  builtin: 'the built-in distraction list',
};

function describe(info) {
  switch (info.reason) {
    case 'custom':
      return { text: 'This site is on your block list.', rule: info.rule };
    case 'list':
      return { text: `This site is on ${LIST_NAMES[info.list] || 'a block list'}.`, rule: info.rule };
    case 'keyword':
      return { text: 'The site address contains a blocked keyword.', rule: `“${info.rule}”` };
    case 'search':
      return { text: `Searches containing blocked keywords are not allowed on ${info.engine}.`, rule: `“${info.rule}”` };
    default:
      return null;
  }
}

async function init() {
  const info = await browser.runtime.sendMessage({ type: 'getBlockInfo' }).catch(() => null);
  const description = info && describe(info);
  if (!description) return;
  $('reason').textContent = description.text;
  $('host').textContent = info.host;
  $('rule').textContent = description.rule;
  $('details').hidden = false;
}

async function closeTab() {
  const tab = await browser.tabs.getCurrent();
  if (tab) browser.tabs.remove(tab.id);
}

$('backBtn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else closeTab();
});
$('closeBtn').addEventListener('click', closeTab);
$('settingsLink').addEventListener('click', () => browser.runtime.openOptionsPage());

init();
