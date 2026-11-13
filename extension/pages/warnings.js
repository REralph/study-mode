/* Setup problems that silently weaken blocking; shown in the popup and on the settings page. */
(function (root) {
  'use strict';

  const ALL_SITES = { origins: ['<all_urls>'] };

  async function render(container) {
    container.replaceChildren();
    if (!(await browser.permissions.contains(ALL_SITES))) {
      add(container, 'Study Mode is not allowed to access websites, so nothing is being blocked.', 'Allow access', async () => {
        if (await browser.permissions.request(ALL_SITES)) render(container);
      });
    }
    if (!(await browser.extension.isAllowedIncognitoAccess())) {
      add(container, 'Private windows are not protected. Open the Firefox menu → Add-ons and themes → Study Mode, and set "Run in Private Windows" to Allow.');
    }
  }

  function add(container, text, buttonLabel, onClick) {
    const box = document.createElement('div');
    box.className = 'warning';
    box.append(Object.assign(document.createElement('p'), { textContent: text }));
    if (buttonLabel) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: buttonLabel });
      button.addEventListener('click', onClick);
      box.append(button);
    }
    container.append(box);
  }

  root.SBWarnings = { render };
})(globalThis);
