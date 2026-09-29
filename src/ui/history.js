// Logica compartilhada da UI de historico de falhas. Usada por popup.html e
// pelo painel do DevTools (panel.html). Faz o CRUD via mensagens ao service
// worker e renderiza lista + detalhes no estilo DevTools.

import { MSG } from '../shared/constants.js';
import { toCurl, toHar, toAzureDevOps, downloadJson, downloadDataUrl } from './export.js';

let allFailures = [];
let filtered = [];
let selectedId = null;
let filterText = '';

const els = {};

function $(id) {
  return document.getElementById(id);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || { ok: false });
      });
    } catch (_e) {
      resolve({ ok: false });
    }
  });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadFailures() {
  const resp = await sendMessage({ type: MSG.GET_FAILURES });
  allFailures = (resp && resp.ok && resp.failures) || [];
  applyFilter();
}

function applyFilter() {
  const q = filterText.trim().toLowerCase();
  filtered = q
    ? allFailures.filter((f) => {
        return (
          (f.url && f.url.toLowerCase().includes(q)) ||
          (f.method && f.method.toLowerCase().includes(q)) ||
          String(f.status).includes(q) ||
          (f.errorType && f.errorType.toLowerCase().includes(q))
        );
      })
    : allFailures.slice();
  renderList();
  renderDetail();
}

// ---------------------------------------------------------------------------
// Render: lista
// ---------------------------------------------------------------------------
function statusClass(f) {
  if (f.errorType) return 'err';
  if (f.status >= 500) return 's5';
  if (f.status >= 400) return 's4';
  return '';
}

function statusLabel(f) {
  if (f.errorType) return '(net)';
  return String(f.status || '—');
}

function splitUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: (u.pathname || '/') + (u.search || '') };
  } catch (_e) {
    return { host: '', path: url || '' };
  }
}

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  } catch (_e) {
    return '';
  }
}

function renderList() {
  const list = els.list;
  els.count.textContent =
    filtered.length + (filtered.length === 1 ? ' falha' : ' falhas');

  if (!filtered.length) {
    list.innerHTML =
      '<div class="empty-state">Nenhuma falha capturada ainda.<br>Navegue com a extensao ativa e as requisicoes com erro aparecerao aqui.</div>';
    return;
  }

  const rows = filtered.map((f) => {
    const { host, path } = splitUrl(f.url);
    const sel = f.id === selectedId ? ' selected' : '';
    const countBadge =
      f.count && f.count > 1
        ? '<span class="count-badge" title="' + f.count + ' ocorrencias">×' + f.count + '</span>'
        : '';
    const noteDot = f.note ? '<span class="note-dot" title="Tem anotacao">✎</span>' : '';
    const shotDot = f.screenshot ? '<span class="shot-dot" title="Tem screenshot">▣</span>' : '';
    return (
      '<div class="list-row' + sel + '" data-id="' + f.id + '">' +
      '<span class="status ' + statusClass(f) + '">' + escapeHtml(statusLabel(f)) + '</span>' +
      '<span class="method">' + escapeHtml(f.method || '') + '</span>' +
      '<span class="url-cell"><div class="path">' + escapeHtml(path) + ' ' +
      countBadge + noteDot + shotDot + '</div>' +
      '<div class="host">' + escapeHtml(host) + '</div></span>' +
      '<span class="time-cell">' + escapeHtml(fmtTime(f.timestamp)) +
      (f.durationMs ? '<br>' + f.durationMs + ' ms' : '') + '</span>' +
      '</div>'
    );
  });
  list.innerHTML = rows.join('');

  list.querySelectorAll('.list-row').forEach((row) => {
    row.addEventListener('click', () => {
      selectedId = row.getAttribute('data-id');
      renderList();
      renderDetail();
    });
  });
}

// ---------------------------------------------------------------------------
// Render: detalhe
// ---------------------------------------------------------------------------
function kvBlock(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '<span class="muted">(nenhum)</span>';
  return (
    '<div class="kv">' +
    entries
      .map(
        ([k, v]) =>
          '<span class="k">' + escapeHtml(k) + '</span><span class="v">' +
          escapeHtml(String(v)) + '</span>'
      )
      .join('') +
    '</div>'
  );
}

function prettyBody(text) {
  if (!text) return '<span class="muted">(vazio)</span>';
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch (_e) {
    /* nao e JSON: mantem cru */
  }
  return '<pre class="body-view">' + escapeHtml(out) + '</pre>';
}

function section(id, title, innerHtml) {
  return (
    '<div class="section" data-section="' + id + '">' +
    '<h3>' + escapeHtml(title) + '</h3>' +
    '<div class="section-body">' + innerHtml + '</div>' +
    '</div>'
  );
}

function renderDetail() {
  const detail = els.detail;
  const f = filtered.find((x) => x.id === selectedId) ||
    allFailures.find((x) => x.id === selectedId);

  if (!f) {
    detail.innerHTML =
      '<div class="detail-empty">Selecione uma falha para ver os detalhes.</div>';
    return;
  }

  const generalRows = {
    URL: f.url,
    Metodo: f.method,
    Status: f.errorType
      ? '0 (' + f.errorType + ')'
      : f.status + ' ' + (f.statusText || ''),
    Tipo: f.kind,
    Origem: f.source || 'inject',
    Ocorrencias: String(f.count || 1),
    Duracao: (f.durationMs || 0) + ' ms',
    Quando: new Date(f.timestamp).toLocaleString(),
    Pagina: f.pageUrl || '—'
  };
  if (f.count && f.count > 1) {
    generalRows['Primeira vez'] = new Date(f.firstSeen || f.timestamp).toLocaleString();
    generalRows['Ultima vez'] = new Date(f.lastSeen || f.timestamp).toLocaleString();
  }
  if (f.error) generalRows.Erro = f.error;

  const reqTruncNote = f.requestBodyTruncated
    ? '<div class="truncated-note">Corpo truncado (' +
      f.requestBodyOriginalLength + ' chars no original).</div>'
    : '';
  const respTruncNote = f.responseBodyTruncated
    ? '<div class="truncated-note">Corpo truncado (' +
      f.responseBodyOriginalLength + ' chars no original).</div>'
    : '';

  const noteSection = section(
    'note',
    'Anotacao',
    '<textarea class="note-input" id="note-input" placeholder="Contexto do bug, passos, o que era esperado...">' +
      escapeHtml(f.note || '') +
      '</textarea>' +
      '<div class="note-actions"><button class="btn" id="btn-save-note">Salvar anotacao</button>' +
      '<span class="muted" id="note-status"></span></div>'
  );

  const screenshotSection = f.screenshot
    ? section(
        'shot',
        'Screenshot',
        '<img class="shot-img" src="' + f.screenshot + '" alt="screenshot da falha" />' +
          '<div class="note-actions"><button class="btn" id="btn-shot-dl">Exportar screenshot</button></div>'
      )
    : '';

  detail.innerHTML =
    '<div class="detail-header"><div class="d-url">' +
    (f.errorType ? '<span class="badge-inline err">NETWORK ERROR</span> ' : '') +
    (f.count && f.count > 1
      ? '<span class="badge-inline count">×' + f.count + '</span> '
      : '') +
    escapeHtml(f.url) + '</div></div>' +
    '<div class="detail-actions">' +
    '<button class="btn primary" id="btn-azure">Copiar para Azure DevOps</button>' +
    '<button class="btn" id="btn-curl">Copiar como cURL</button>' +
    '<button class="btn" id="btn-har-one">Exportar HAR</button>' +
    '<button class="btn danger" id="btn-del">Excluir</button>' +
    '</div>' +
    section('general', 'Geral', kvBlock(generalRows)) +
    noteSection +
    screenshotSection +
    section('reqh', 'Request Headers', kvBlock(f.requestHeaders)) +
    section('reqb', 'Request Body', prettyBody(f.requestBody) + reqTruncNote) +
    section('resph', 'Response Headers', kvBlock(f.responseHeaders)) +
    section('respb', 'Response Body', prettyBody(f.responseBody) + respTruncNote);

  // Colapsar/expandir secoes (evita colapsar ao clicar dentro do body).
  detail.querySelectorAll('.section > h3').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  $('btn-azure').addEventListener('click', async () => {
    await copyToClipboard(toAzureDevOps(f));
    toast('Copiado para colar no Azure DevOps');
  });
  $('btn-curl').addEventListener('click', async () => {
    await copyToClipboard(toCurl(f));
    toast('cURL copiado');
  });
  $('btn-har-one').addEventListener('click', () => {
    downloadJson(toHar(f), 'failwatch-' + f.id + '.har');
  });
  $('btn-del').addEventListener('click', async () => {
    await sendMessage({ type: MSG.DELETE_FAILURE, id: f.id });
    if (selectedId === f.id) selectedId = null;
    await loadFailures();
  });

  const saveNoteBtn = $('btn-save-note');
  if (saveNoteBtn) {
    saveNoteBtn.addEventListener('click', async () => {
      const note = $('note-input').value;
      await sendMessage({ type: MSG.UPDATE_NOTE, id: f.id, note });
      // Atualiza em memoria sem re-render completo (mantem foco/scroll).
      f.note = note;
      const status = $('note-status');
      if (status) {
        status.textContent = 'Salvo';
        setTimeout(() => {
          if (status) status.textContent = '';
        }, 1500);
      }
    });
  }

  const shotBtn = $('btn-shot-dl');
  if (shotBtn && f.screenshot) {
    shotBtn.addEventListener('click', () => {
      downloadDataUrl(f.screenshot, 'failwatch-' + f.id + '.jpg');
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_e) {
    // Fallback via textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (_e2) {
      /* ignore */
    }
    ta.remove();
  }
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1600);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
export function initHistoryUI() {
  els.list = $('list');
  els.detail = $('detail');
  els.count = $('count');
  els.toast = $('toast');

  $('search').addEventListener('input', (e) => {
    filterText = e.target.value || '';
    applyFilter();
  });

  $('btn-clear').addEventListener('click', async () => {
    await sendMessage({ type: MSG.CLEAR_FAILURES });
    selectedId = null;
    await loadFailures();
  });

  $('btn-har-all').addEventListener('click', () => {
    if (!filtered.length) {
      toast('Nada para exportar');
      return;
    }
    downloadJson(toHar(filtered), 'failwatch-export.har');
  });

  $('btn-refresh').addEventListener('click', loadFailures);

  $('btn-options').addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_e) {
      /* ignore */
    }
  });

  // Recarrega quando o SW avisa que a lista mudou.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === MSG.FAILURES_CHANGED) {
      loadFailures();
    }
  });

  loadFailures();
}
