// ==UserScript==
// @name         keenetic-geosite-sync
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Autocomplete + API buttons for Keenetic DNS routes (v2fly/domain-list-community)
// @homepage     https://github.com/yangirov/keenetic-geosite-sync
// @match        http://192.168.1.1/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.github.com
// ==/UserScript==

(function () {
  'use strict';

  /* ================== CONFIG ================== */

  const FORCE_REFRESH = false;

  const DNS_ROUTE_PREFIX = '/staticRoutes/dns';

  const INPUT_SELECTOR =
    'input.ndw-input__value[formcontrolname="value"][maxlength="64"]';

  const BUTTONS_CONTAINER_SELECTOR =
    '.domain-name-list__buttons-row';

  const API_BASE = 'http://192.168.1.1:3939';

  const API_ACTIONS = [
    { label: 'Health', url: '/health' },
    { label: 'Sync', url: '/sync' },
    { label: 'Clean', url: '/clean' },
  ];

  const CACHE_KEY = 'v2fly-domain-list-names';
  const CACHE_TS_KEY = 'v2fly-domain-list-ts';
  const CACHE_TTL = 24 * 60 * 60 * 1000;

  const MAX_ITEMS = 20;

  const TREE_URL =
    'https://api.github.com/repos/v2fly/domain-list-community/git/trees/master?recursive=1';

  /* ================== ROUTE ================== */

  const isDnsRoute = () =>
    location.pathname.startsWith(DNS_ROUTE_PREFIX);

  /* ================== CACHE ================== */

  if (FORCE_REFRESH) {
    GM_deleteValue(CACHE_KEY);
    GM_deleteValue(CACHE_TS_KEY);
    console.log('[TM] cache force-cleared');
  }

  /* ================== UTILS ================== */

  const log = (...a) => console.log('[TM]', ...a);

  function gmFetchJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'json',
        headers: { Accept: 'application/vnd.github+json' },
        onload: r =>
          r.status >= 200 && r.status < 300
            ? resolve(r.response)
            : reject(new Error(`HTTP ${r.status}`)),
        onerror: reject,
      });
    });
  }

  /* ================== DATA ================== */

  function extractNamesFromTree(tree) {
    return tree
      .filter(
        n =>
          n.type === 'blob' &&
          n.path.startsWith('data/') &&
          !n.path.slice(5).includes('/')
      )
      .map(n => n.path.slice(5))
      .sort();
  }

  async function loadNames() {
    const cached = GM_getValue(CACHE_KEY, null);
    const ts = GM_getValue(CACHE_TS_KEY, 0);

    if (cached && Date.now() - ts < CACHE_TTL) return cached;

    log('loading domain list');
    const json = await gmFetchJson(TREE_URL);
    const names = extractNamesFromTree(json.tree);

    GM_setValue(CACHE_KEY, names);
    GM_setValue(CACHE_TS_KEY, Date.now());
    return names;
  }

  /* ================== INPUT ================== */

  function findTargetInput() {
    if (!isDnsRoute()) return null;

    const inputs = document.querySelectorAll(INPUT_SELECTOR);
    if (!inputs.length) return null;
    if (inputs.length === 1) return inputs[0];
    return Array.from(inputs).find(i => i.offsetParent !== null) || null;
  }

  function disableNativeAutocomplete(input) {
    if (input.__tmAutocompleteDisabled) return;
    input.__tmAutocompleteDisabled = true;

    input.setAttribute('autocomplete', 'new-password');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('name', `__tm_${Math.random().toString(36).slice(2)}`);
  }

  /* ================== DROPDOWN ================== */

  const dropdown = (() => {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: 99999,
      background: '#fff',
      border: '1px solid #ccc',
      borderRadius: '4px',
      maxHeight: '200px',
      overflowY: 'auto',
      fontSize: '14px',
      display: 'none',
      boxShadow: '0 4px 12px rgba(0,0,0,.15)',
    });
    document.body.appendChild(el);

    return {
      el,
      show(input) {
        const r = input.getBoundingClientRect();
        el.style.left = r.left + 'px';
        el.style.top = r.bottom + 'px';
        el.style.width = r.width + 'px';
        el.style.display = 'block';
      },
      hide() {
        el.style.display = 'none';
      },
    };
  })();

  /* ================== API BUTTONS ================== */

  function injectApiButtons() {
    if (!isDnsRoute()) return;

    const container = document.querySelector(BUTTONS_CONTAINER_SELECTOR);
    if (!container || container.__tmApiInjected) return;

    const template = container.querySelector('.ndw-button-wrapper');
    if (!template) return;

    container.__tmApiInjected = true;

    const spacer = document.createElement('div');
    spacer.style.width = '12px';
    container.appendChild(spacer);

    API_ACTIONS.forEach(({ label, url }) => {
      const wrapper = template.cloneNode(true);
      const btn = wrapper.querySelector('button');
      const span = btn.querySelector('span');

      btn.querySelectorAll('ndw-svg-icon').forEach(el => el.remove());
      if (span) span.textContent = label;
      else btn.textContent = label;

      btn.disabled = false;
      btn.onclick = e => {
        e.preventDefault();
        e.stopPropagation();
        window.open(`${API_BASE}${url}`, '_blank', 'noopener');
      };

      container.appendChild(wrapper);
    });

    log('API buttons injected');
  }

  /* ================== STATE ================== */

  let names = null;
  let currentInput = null;
  let lastPathname = location.pathname;

  function teardown() {
    currentInput = null;
    dropdown.hide();
  }

  async function ensureAttached() {
    if (!isDnsRoute()) return teardown();

    if (!names) {
      try {
        names = await loadNames();
      } catch (e) {
        log('failed to load domain list', e);
        return;
      }
    }

    injectApiButtons();

    const input = findTargetInput();
    if (!input || currentInput === input) return;

    currentInput = input;
    disableNativeAutocomplete(input);

    if (input.__tmOnInput) {
      input.removeEventListener('input', input.__tmOnInput, true);
      input.removeEventListener('keyup', input.__tmOnInput, true);
    }

    const onInput = () => {
      const v = input.value.trim().toLowerCase();
      dropdown.el.innerHTML = '';
      if (!v) return dropdown.hide();

      let count = 0;
      for (const n of names) {
        if (!n.includes(v)) continue;

        const item = document.createElement('div');
        item.textContent = n;
        item.style.padding = '6px 8px';
        item.style.cursor = 'pointer';

        item.onmouseenter = () => (item.style.background = '#f0f0f0');
        item.onmouseleave = () => (item.style.background = '');

        item.onclick = () => {
          input.value = n;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          dropdown.hide();
        };

        dropdown.el.appendChild(item);
        if (++count >= MAX_ITEMS) break;
      }

      count ? dropdown.show(input) : dropdown.hide();
    };

    input.__tmOnInput = onInput;
    input.addEventListener('input', onInput, true);
    input.addEventListener('keyup', onInput, true);
  }

  /* ================== ROUTE WATCH ================== */

  function checkRouteChange() {
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    teardown();
    ensureAttached();
  }

  const mo = new MutationObserver(() => {
    checkRouteChange();
    ensureAttached();
  });

  mo.observe(document.body, { childList: true, subtree: true });

  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      checkRouteChange();
      return r;
    };
  });

  window.addEventListener('popstate', checkRouteChange);
  document.addEventListener('focusin', ensureAttached, true);

  document.addEventListener(
    'click',
    e => {
      if (e.target !== currentInput && !dropdown.el.contains(e.target)) {
        dropdown.hide();
      }
    },
    true
  );

  log('userscript ready');
})();
