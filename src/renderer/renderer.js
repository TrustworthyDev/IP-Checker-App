'use strict';

/* IPCheck renderer. Talks to the main process only through `window.api`. */

const $ = (id) => document.getElementById(id);

const el = {
  proxyInput: $('proxyInput'),
  parseInfo: $('parseInfo'),
  parseErrors: $('parseErrors'),
  defaultScheme: $('defaultScheme'),
  btnCheck: $('btnCheck'),
  btnStop: $('btnStop'),
  btnImport: $('btnImport'),
  btnClear: $('btnClear'),
  progressWrap: $('progressWrap'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),

  stats: $('stats'),
  statTotal: $('statTotal'),
  statGood: $('statGood'),
  statWarn: $('statWarn'),
  statBad: $('statBad'),
  statError: $('statError'),

  search: $('search'),
  resultsBody: $('resultsBody'),
  emptyState: $('emptyState'),
  btnCopyGood: $('btnCopyGood'),
  btnExportCsv: $('btnExportCsv'),

  btnSettings: $('btnSettings'),
  settingsPanel: $('settingsPanel'),
  apiKey: $('apiKey'),
  concurrency: $('concurrency'),
  timeoutMs: $('timeoutMs'),
  btnSaveSettings: $('btnSaveSettings'),
  settingsSaved: $('settingsSaved'),
  linkKey: $('linkKey'),

  btnOwnIp: $('btnOwnIp'),
  ownIpValue: $('ownIpValue'),

  keyBanner: $('keyBanner'),
  btnBannerKey: $('btnBannerKey'),
  tierBanner: $('tierBanner'),
  btnTierDismiss: $('btnTierDismiss'),

  layout: document.querySelector('.layout'),
  viewerPane: $('viewerPane'),
  viewerSurface: $('viewerSurface'),
  viewerUrl: $('viewerUrl'),
  viewerLoading: $('viewerLoading'),
  viewerBack: $('viewerBack'),
  viewerReload: $('viewerReload'),
  viewerExternal: $('viewerExternal'),
  viewerClose: $('viewerClose'),

  toast: $('toast'),
};

const state = {
  results: [],
  filter: 'all',
  search: '',
  running: false,
  quotaWarned: false,
  tierDismissed: false,
  // Result ids whose detail panel is open. Survives re-renders from
  // filtering/searching, so an open row stays open.
  expanded: new Set(),
};

/* ------------------------------------------------------------------ helpers */

let toastTimer = null;
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', isError);
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 3200);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * The endpoint is what identifies a row, so it gets the space; scheme and
 * whether the proxy is authenticated ride along as tags. Full original line
 * (credentials included) stays available as the cell tooltip.
 */
function proxyCell(proxy) {
  const td = document.createElement('td');
  td.className = 'proxy-cell';
  td.title = proxy.raw;

  const endpoint = document.createElement('span');
  endpoint.className = 'mono proxy-endpoint';
  endpoint.textContent = `${proxy.host}:${proxy.port}`;
  td.append(endpoint);

  const scheme = document.createElement('span');
  scheme.className = 'tag';
  scheme.textContent = proxy.scheme;
  td.append(scheme);

  if (proxy.username) {
    const auth = document.createElement('span');
    auth.className = 'tag';
    auth.textContent = 'auth';
    auth.title = `Authenticating as ${proxy.username}`;
    td.append(auth);
  }

  return td;
}

/** Original line, credentials intact — used for copy/export. */
function proxyRaw(proxy) {
  return proxy.raw;
}

/** Connection URL with credentials percent-encoded, as the agents build it. */
function proxyUrl(proxy) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}`;
}

/* ------------------------------------------------------------------ parsing */

const refreshParse = debounce(async () => {
  const text = el.proxyInput.value;
  if (!text.trim()) {
    el.parseInfo.textContent = '0 proxies';
    el.parseErrors.classList.add('hidden');
    return;
  }

  const { proxies, errors, duplicates } = await window.api.parseProxies(
    text,
    el.defaultScheme.value
  );

  const parts = [`${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'}`];
  if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`);
  if (errors.length) parts.push(`${errors.length} invalid`);
  el.parseInfo.textContent = parts.join(' · ');

  el.parseErrors.replaceChildren();
  if (errors.length) {
    // Cap the visible list; a badly-pasted 5000-line file shouldn't fill the panel.
    errors.slice(0, 20).forEach((error) => {
      const row = document.createElement('div');
      row.textContent = `Line ${error.line}: ${error.error} — ${error.raw.slice(0, 60)}`;
      el.parseErrors.append(row);
    });
    if (errors.length > 20) {
      const more = document.createElement('div');
      more.textContent = `…and ${errors.length - 20} more`;
      el.parseErrors.append(more);
    }
    el.parseErrors.classList.remove('hidden');
  } else {
    el.parseErrors.classList.add('hidden');
  }
}, 250);

/* ----------------------------------------------------------------- rendering */

function verdictBadge(result) {
  const badge = document.createElement('span');

  if (result.verdict === 'error') {
    badge.className = 'badge badge-error';
    badge.textContent = 'Failed';
    return badge;
  }
  if (result.verdict === 'unknown') {
    badge.className = 'badge badge-unknown';
    badge.textContent = 'Unknown';
    badge.title = result.error || 'iphub did not return a block status';
    return badge;
  }

  const labels = { good: 'Good · 0', warn: 'Risky · 2', bad: 'Blocked · 1' };
  badge.className = `badge badge-${result.verdict}`;
  badge.textContent = labels[result.verdict] || result.verdict;
  // blockReason (API v2.2) explains *why*; fall back to the code's meaning.
  badge.title = [result.blockLabel, result.blockReason].filter(Boolean).join(' — ');
  return badge;
}

/** v2.2 proxyType flags, shown as tags so the reason is visible at a glance. */
function proxyTypeTags(proxyType) {
  const NAMES = {
    proxy: 'proxy',
    tor: 'tor',
    hosting: 'hosting',
    relay: 'relay',
    residentialProxy: 'residential proxy',
    cloudGaming: 'cloud gaming',
  };
  return Object.entries(NAMES)
    .filter(([key]) => proxyType && proxyType[key])
    .map(([, name]) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = name;
      return tag;
    });
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text == null || text === '' ? '—' : String(text);
  if (text == null || text === '') td.classList.add('muted');
  return td;
}

/* ------------------------------------------------------- expandable details */

/**
 * One labelled field with its own copy button, so each part of the proxy can
 * be lifted out independently rather than re-parsed from the joined line.
 */
function detailField(label, value, options = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-field';

  const name = document.createElement('span');
  name.className = 'detail-label';
  name.textContent = label;
  wrap.append(name);

  const row = document.createElement('div');
  row.className = 'detail-value-row';

  const text = document.createElement('span');
  text.className = 'detail-value';
  if (options.mono !== false) text.classList.add('mono');

  const empty = value == null || value === '';
  text.textContent = empty ? (options.emptyText || '—') : String(value);
  if (empty) text.classList.add('muted');
  if (options.danger && !empty) text.classList.add('error-text');
  row.append(text);

  if (!empty && options.copyable !== false) {
    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.type = 'button';
    copy.textContent = 'copy';
    copy.title = `Copy ${label.toLowerCase()}`;
    copy.dataset.copy = String(value);
    row.append(copy);
  }

  wrap.append(row);
  return wrap;
}

function detailSection(title, fields) {
  const section = document.createElement('div');
  section.className = 'detail-section';

  const heading = document.createElement('h3');
  heading.className = 'detail-heading';
  heading.textContent = title;
  section.append(heading);

  fields.filter(Boolean).forEach((field) => section.append(field));
  return section;
}

/** The expanded panel: every proxy component split out, plus the iphub result. */
function buildDetailRow(result) {
  const proxy = result.proxy;

  const tr = document.createElement('tr');
  tr.className = 'detail-row';
  tr.dataset.detailFor = result.id;

  const td = document.createElement('td');
  td.colSpan = 7;

  const grid = document.createElement('div');
  grid.className = 'detail-grid';

  grid.append(
    detailSection('Proxy', [
      detailField('Protocol', proxy.scheme),
      detailField('Host', proxy.host),
      detailField('Port', proxy.port),
      detailField('Username', proxy.username, { emptyText: 'none (no auth)' }),
      detailField('Password', proxy.password, { emptyText: 'none (no auth)' }),
      detailField('Connection URL', proxyUrl(proxy)),
      detailField('Original line', proxy.raw),
    ])
  );

  const detections = result.proxyType
    ? Object.entries(result.proxyType)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .join(', ')
    : '';

  const iphubSection = detailSection('iphub.info result', [
      detailField('Exit IP', result.exitIp),
      detailField(
        'Block code',
        result.block != null ? `${result.block} — ${result.blockLabel || ''}`.trim() : '',
        { emptyText: 'not scored', mono: false }
      ),
      result.blockReason
        ? detailField('Block reason', result.blockReason, { mono: false })
        : null,
      detections ? detailField('Detected as', detections, { mono: false }) : null,
      detailField('Country', [result.countryName, result.countryCode].filter(Boolean).join(' · '), {
        mono: false,
      }),
      detailField('ISP', result.isp, { mono: false }),
      detailField('ASN', result.asn ? `AS${String(result.asn).replace(/^AS/i, '')}` : ''),
      detailField('Reverse DNS', result.hostname),
      detailField('Latency', result.latencyMs != null ? `${result.latencyMs} ms` : '', {
        copyable: false,
      }),
      result.rotating
        ? detailField('Note', 'Exit IP differs from the endpoint dialled (backconnect / rotating)', {
            mono: false,
            copyable: false,
          })
        : null,
      result.error ? detailField('Error', result.error, { mono: false, danger: true }) : null,
    ]);

  // Manual escape hatch to the website, which shows Professional-tier
  // detection (residential proxies) that a Basic key does not return. Opens in
  // the user's browser -- one IP, viewed by a person, as the site intends.
  if (result.exitIp) {
    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link-btn';
    open.dataset.openIp = result.exitIp;
    open.textContent = 'View on iphub.info';
    open.title =
      'Open this exit IP in the built-in iphub.info panel. The site shows Professional-tier ' +
      'detection (including residential proxies) that the free Basic API key does not return.';
    actions.append(open);
    iphubSection.append(actions);
  }

  grid.append(iphubSection);

  td.append(grid);
  tr.append(td);
  return tr;
}

function buildRow(result, index) {
  const tr = document.createElement('tr');
  tr.className = 'result-row';
  tr.dataset.id = result.id;
  if (result.verdict === 'error') tr.classList.add('row-error');
  if (state.expanded.has(result.id)) tr.classList.add('is-expanded');

  const numTd = cell(index + 1, 'col-num');
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▸'; // ▸, rotated via CSS when expanded
  numTd.prepend(caret);
  tr.append(numTd);

  tr.append(proxyCell(result.proxy));

  // Exit IP, or the failure reason when the proxy never connected.
  const ipTd = document.createElement('td');
  if (result.exitIp) {
    // Clicking the IP opens it in the iphub.info panel.
    ipTd.className = 'mono exit-ip-cell';
    ipTd.dataset.ip = result.exitIp;
    ipTd.title = `Open ${result.exitIp} on iphub.info`;
    ipTd.textContent = result.exitIp;
    if (result.rotating) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'rotating';
      tag.title = 'Exit IP differs from the endpoint you dialled (backconnect pool)';
      ipTd.append(tag);
    }
  } else {
    ipTd.className = 'error-text';
    ipTd.textContent = result.error || 'no response';
    ipTd.title = result.error || '';
  }
  tr.append(ipTd);

  const blockTd = document.createElement('td');
  blockTd.append(verdictBadge(result));
  proxyTypeTags(result.proxyType).forEach((tag) => blockTd.append(tag));
  if (result.cached) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'cached';
    tag.title = 'Same exit IP already looked up in this run';
    blockTd.append(tag);
  }
  tr.append(blockTd);

  const country = result.countryName
    ? result.countryCode
      ? `${result.countryName} (${result.countryCode})`
      : result.countryName
    : result.countryCode;
  const countryTd = cell(country, 'col-country');
  if (country) countryTd.title = country;
  tr.append(countryTd);

  const isp = [result.isp, result.asn ? `AS${String(result.asn).replace(/^AS/i, '')}` : null]
    .filter(Boolean)
    .join(' · ');
  tr.append(cell(isp));

  tr.append(cell(result.latencyMs != null ? `${result.latencyMs} ms` : '', 'col-ms'));

  return tr;
}

function matchesFilter(result) {
  if (state.filter !== 'all' && result.verdict !== state.filter) {
    // "error" bucket also collects alive-but-unscored proxies.
    if (!(state.filter === 'error' && result.verdict === 'unknown')) return false;
  }
  if (!state.search) return true;

  const needle = state.search.toLowerCase();
  return [
    result.proxy.host,
    result.proxy.raw,
    result.exitIp,
    result.countryName,
    result.countryCode,
    result.isp,
    result.asn,
    result.error,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function render() {
  const visible = state.results.filter(matchesFilter);

  const fragment = document.createDocumentFragment();
  visible.forEach((result, index) => {
    fragment.append(buildRow(result, index));
    if (state.expanded.has(result.id)) fragment.append(buildDetailRow(result));
  });
  el.resultsBody.replaceChildren(fragment);

  el.emptyState.classList.toggle('hidden', state.results.length > 0);

  if (state.results.length > 0 && visible.length === 0) {
    el.resultsBody.append(placeholderRow());
  }

  updateStats();
}

function placeholderRow() {
  const tr = document.createElement('tr');
  tr.className = 'placeholder-row';
  const td = document.createElement('td');
  td.colSpan = 7;
  td.textContent = 'No rows match the current filter.';
  tr.append(td);
  return tr;
}

/**
 * Append a single streamed result instead of re-rendering the table. A full
 * render per result is O(n^2) row builds over a run, which is very visible on
 * a list of a few hundred proxies.
 */
function appendResult(result) {
  el.emptyState.classList.add('hidden');

  const placeholder = el.resultsBody.querySelector('.placeholder-row');
  if (placeholder) placeholder.remove();

  if (matchesFilter(result)) {
    // Count only result rows: detail rows are interleaved and must not
    // contribute to the visible row number.
    const position = el.resultsBody.querySelectorAll('tr.result-row').length;
    el.resultsBody.append(buildRow(result, position));
  } else if (el.resultsBody.children.length === 0) {
    el.resultsBody.append(placeholderRow());
  }

  updateStats();
}

function updateStats() {
  const counts = { good: 0, warn: 0, bad: 0, error: 0 };
  state.results.forEach((result) => {
    if (result.verdict === 'good') counts.good += 1;
    else if (result.verdict === 'warn') counts.warn += 1;
    else if (result.verdict === 'bad') counts.bad += 1;
    else counts.error += 1; // error + unknown
  });

  el.statTotal.textContent = state.results.length;
  el.statGood.textContent = counts.good;
  el.statWarn.textContent = counts.warn;
  el.statBad.textContent = counts.bad;
  el.statError.textContent = counts.error;
}

/* ------------------------------------------------------------------- checks */

function setRunning(running) {
  state.running = running;
  el.btnCheck.classList.toggle('hidden', running);
  el.btnStop.classList.toggle('hidden', !running);
  el.progressWrap.classList.toggle('hidden', !running);
  el.btnImport.disabled = running;
  el.btnClear.disabled = running;
  el.proxyInput.readOnly = running;
}

async function startCheck() {
  if (state.running) return;
  if (!el.proxyInput.value.trim()) {
    toast('Paste a proxy list first', true);
    return;
  }

  state.results = [];
  state.quotaWarned = false;
  state.expanded.clear();
  render();
  setRunning(true);
  el.progressFill.style.width = '0%';
  el.progressText.textContent = '0 / 0';

  // Persist before the run, not after, so the list survives closing mid-check.
  window.api.saveSettings({ lastList: el.proxyInput.value, defaultScheme: el.defaultScheme.value });

  const response = await window.api.startCheck(el.proxyInput.value, el.defaultScheme.value);
  if (!response.ok) {
    setRunning(false);
    toast(response.error || 'Check failed', true);
  }
}

window.api.onStarted(({ total }) => {
  el.progressText.textContent = `0 / ${total}`;
});

window.api.onResult(({ result, completed, total }) => {
  state.results.push(result);

  const percent = total ? Math.round((completed / total) * 100) : 0;
  el.progressFill.style.width = `${percent}%`;
  el.progressText.textContent = `${completed} / ${total}`;

  // These conditions repeat on every row; warn once per run, not 500 times.
  if (result.missingKey) {
    el.keyBanner.classList.remove('hidden');
  } else if (result.quotaExceeded && !state.quotaWarned) {
    state.quotaWarned = true;
    toast(result.error, true);
  }

  appendResult(result);
});

window.api.onDone(({ cancelled, completed, total, error }) => {
  setRunning(false);

  /*
   * A Basic-tier key returns v2.0-shaped data with no proxyType block. If we
   * scored anything and never saw one, residential-proxy detection was not part
   * of any answer -- say so, because "Good · 0" otherwise reads as "clean".
   */
  const scored = state.results.some((r) => r.block != null);
  if (scored && !state.results.some((r) => r.proxyType) && !state.tierDismissed) {
    el.tierBanner.classList.remove('hidden');
  }

  if (error) toast(error, true);
  else if (cancelled) toast(`Stopped after ${state.results.length} checks`);
  else toast(`Finished — ${completed ?? total} proxies checked`);
});

/* ------------------------------------------------------------------ exports */

function goodProxies() {
  return state.results.filter((r) => r.verdict === 'good').map((r) => proxyRaw(r.proxy));
}

async function copyGood() {
  const good = goodProxies();
  if (good.length === 0) {
    toast('No good proxies to copy', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(good.join('\n'));
    toast(`Copied ${good.length} good prox${good.length === 1 ? 'y' : 'ies'}`);
  } catch {
    toast('Clipboard write was blocked', true);
  }
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportCsv() {
  if (state.results.length === 0) {
    toast('Nothing to export', true);
    return;
  }

  const header = [
    'proxy',
    'scheme',
    'host',
    'port',
    'status',
    'exit_ip',
    'block',
    'verdict',
    'block_label',
    'block_reason',
    'proxy_types',
    'country',
    'country_code',
    'isp',
    'asn',
    'hostname',
    'latency_ms',
    'error',
  ];

  const rows = state.results.map((r) =>
    [
      r.proxy.raw,
      r.proxy.scheme,
      r.proxy.host,
      r.proxy.port,
      r.status,
      r.exitIp,
      r.block,
      r.verdict,
      r.blockLabel,
      r.blockReason,
      r.proxyType
        ? Object.entries(r.proxyType)
            .filter(([, on]) => on)
            .map(([name]) => name)
            .join(' ')
        : '',
      r.countryName,
      r.countryCode,
      r.isp,
      r.asn,
      r.hostname,
      r.latencyMs,
      r.error,
    ]
      .map(csvEscape)
      .join(',')
  );

  const content = [header.join(','), ...rows].join('\r\n');
  const response = await window.api.exportFile(content, 'ipcheck-results.csv', 'csv');
  if (response.ok) toast(`Saved to ${response.path}`);
  else if (response.error) toast(response.error, true);
}

/* ----------------------------------------------------- embedded iphub viewer */

/**
 * The native view has no idea about CSS layout, so the renderer reports the
 * rect of the reserved surface and the main process positions the view there.
 */
function viewerBounds() {
  const rect = el.viewerSurface.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function openViewer(ip) {
  el.viewerPane.classList.remove('hidden');
  el.layout.classList.add('with-viewer');
  el.viewerLoading.classList.remove('hidden');

  const url = `https://iphub.info/?ip=${encodeURIComponent(ip)}`;
  el.viewerUrl.textContent = url;

  // Let the grid reflow before measuring, or the view lands at the old width.
  requestAnimationFrame(() => {
    window.api.openViewer(url, viewerBounds()).then((response) => {
      if (response && !response.ok) toast(response.error, true);
    });
  });
}

function closeViewer() {
  window.api.closeViewer();
  el.viewerPane.classList.add('hidden');
  el.layout.classList.remove('with-viewer');
}

// Any layout change -- window resize, panel toggling -- must move the view.
if (window.ResizeObserver) {
  const observer = new ResizeObserver(() => {
    if (!el.viewerPane.classList.contains('hidden')) {
      window.api.setViewerBounds(viewerBounds());
    }
  });
  observer.observe(el.viewerSurface);
}
window.addEventListener('resize', () => {
  if (!el.viewerPane.classList.contains('hidden')) {
    window.api.setViewerBounds(viewerBounds());
  }
});

window.api.onViewerState((state) => {
  if (state.url) el.viewerUrl.textContent = state.url;
  if (state.loading != null) el.viewerLoading.classList.toggle('hidden', !state.loading);
  if (state.canGoBack != null) el.viewerBack.disabled = !state.canGoBack;
});

el.viewerClose.addEventListener('click', closeViewer);
el.viewerReload.addEventListener('click', () => window.api.reloadViewer());
el.viewerBack.addEventListener('click', () => window.api.viewerBack());
el.viewerExternal.addEventListener('click', () => window.api.viewerExternal());

/* ----------------------------------------------------------------- settings */

async function loadSettings() {
  const settings = await window.api.loadSettings();
  el.apiKey.value = settings.apiKey || '';
  el.concurrency.value = settings.concurrency;
  el.timeoutMs.value = settings.timeoutMs;
  el.defaultScheme.value = settings.defaultScheme || 'http';
  if (settings.lastList) {
    el.proxyInput.value = settings.lastList;
    refreshParse();
  }

  // Without a key nothing can be scored, so lead with it on first run.
  updateKeyBanner(settings.apiKey);
  if (!settings.apiKey) el.settingsPanel.classList.remove('hidden');
}

function updateKeyBanner(apiKey) {
  el.keyBanner.classList.toggle('hidden', Boolean(apiKey && apiKey.trim()));
}

async function saveSettings() {
  const saved = await window.api.saveSettings({
    apiKey: el.apiKey.value.trim(),
    concurrency: Number(el.concurrency.value),
    timeoutMs: Number(el.timeoutMs.value),
    defaultScheme: el.defaultScheme.value,
  });

  el.concurrency.value = saved.concurrency;
  el.timeoutMs.value = saved.timeoutMs;

  if (saved.saveError) {
    toast(`Could not save: ${saved.saveError}`, true);
    return;
  }
  updateKeyBanner(saved.apiKey);
  el.settingsSaved.textContent = 'Saved';
  setTimeout(() => {
    el.settingsSaved.textContent = '';
  }, 2000);
}

/* ------------------------------------------------------------------- events */

el.proxyInput.addEventListener('input', refreshParse);
el.defaultScheme.addEventListener('change', refreshParse);

el.btnCheck.addEventListener('click', startCheck);
el.btnStop.addEventListener('click', () => window.api.cancelCheck());

el.btnImport.addEventListener('click', async () => {
  const response = await window.api.importFile();
  if (response.ok) {
    el.proxyInput.value = response.text;
    refreshParse();
    toast('List imported');
  } else if (response.error) {
    toast(response.error, true);
  }
});

el.btnClear.addEventListener('click', () => {
  el.proxyInput.value = '';
  state.results = [];
  state.expanded.clear();
  refreshParse();
  render();
});

el.stats.addEventListener('click', (event) => {
  const button = event.target.closest('.stat');
  if (!button) return;
  state.filter = button.dataset.filter;
  [...el.stats.children].forEach((child) => child.classList.toggle('is-active', child === button));
  render();
});

el.search.addEventListener(
  'input',
  debounce(() => {
    state.search = el.search.value.trim();
    render();
  }, 180)
);

/**
 * Row expansion + per-field copy, via delegation so streamed rows need no
 * per-row listeners.
 */
el.resultsBody.addEventListener('click', async (event) => {
  const openBtn = event.target.closest('.link-btn');
  if (openBtn) {
    event.stopPropagation();
    openViewer(openBtn.dataset.openIp);
    return;
  }

  const copyBtn = event.target.closest('.copy-btn');
  if (copyBtn) {
    // Don't let the copy click bubble into the row toggle.
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copy);
      const previous = copyBtn.textContent;
      copyBtn.textContent = 'copied';
      copyBtn.classList.add('is-copied');
      setTimeout(() => {
        copyBtn.textContent = previous;
        copyBtn.classList.remove('is-copied');
      }, 1200);
    } catch {
      toast('Clipboard write was blocked', true);
    }
    return;
  }

  const row = event.target.closest('tr.result-row');
  if (!row) return;

  // Cells are selectable; a click that ends a text selection shouldn't act.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;

  // Exit IP opens the iphub.info panel for that address.
  const ipCell = event.target.closest('td.exit-ip-cell');
  if (ipCell && ipCell.dataset.ip) {
    openViewer(ipCell.dataset.ip);
    return;
  }

  // The proxy (and the number/caret beside it) toggles the detail panel.
  if (event.target.closest('td.proxy-cell, td.col-num')) {
    toggleRow(row);
  }
});

function toggleRow(row) {
  const id = row.dataset.id;
  const result = state.results.find((r) => r.id === id);
  if (!result) return;

  const existing = el.resultsBody.querySelector(`tr.detail-row[data-detail-for="${CSS.escape(id)}"]`);
  if (existing) {
    existing.remove();
    row.classList.remove('is-expanded');
    state.expanded.delete(id);
    return;
  }

  row.after(buildDetailRow(result));
  row.classList.add('is-expanded');
  state.expanded.add(id);
}

el.btnCopyGood.addEventListener('click', copyGood);
el.btnExportCsv.addEventListener('click', exportCsv);

el.btnSettings.addEventListener('click', () => el.settingsPanel.classList.toggle('hidden'));
el.btnSaveSettings.addEventListener('click', saveSettings);
el.linkKey.addEventListener('click', (event) => {
  event.preventDefault();
  window.api.openExternal('https://iphub.info/pricing');
});

el.btnTierDismiss.addEventListener('click', () => {
  // Dismissal lasts for the session; a new run on a new key re-evaluates.
  state.tierDismissed = true;
  el.tierBanner.classList.add('hidden');
});

el.btnBannerKey.addEventListener('click', () => {
  el.settingsPanel.classList.remove('hidden');
  el.apiKey.focus();
});

el.btnOwnIp.addEventListener('click', async () => {
  el.btnOwnIp.disabled = true;
  el.ownIpValue.textContent = 'checking…';
  const response = await window.api.checkOwnIp();
  el.btnOwnIp.disabled = false;

  if (!response.ok) {
    el.ownIpValue.textContent = '—';
    toast(response.error, true);
    return;
  }

  const { exitIp, block, countryCode } = response.result;
  el.ownIpValue.textContent = countryCode ? `${exitIp} · ${countryCode}` : exitIp;
  el.ownIpValue.title = `block ${block ?? '?'} — ${response.result.blockLabel}`;
});

// Ctrl+Enter runs the check from anywhere in the window.
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    startCheck();
  }
});

loadSettings();
render();
