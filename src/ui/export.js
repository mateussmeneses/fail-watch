// Utilitarios de exportacao: "copiar como cURL" e exportar HAR.
// HAR (HTTP Archive) e o formato que o DevTools usa para exportar tráfego,
// entao qualquer dev consegue reimportar num navegador para reproduzir.

// Escapa uma string para uso seguro dentro de aspas simples no shell.
function shellQuote(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

export function toCurl(entry) {
  const parts = ['curl'];
  const method = (entry.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    parts.push('-X', method);
  }
  parts.push(shellQuote(entry.url));

  const headers = entry.requestHeaders || {};
  for (const [key, value] of Object.entries(headers)) {
    parts.push('-H', shellQuote(key + ': ' + value));
  }

  if (entry.requestBody) {
    parts.push('--data-raw', shellQuote(entry.requestBody));
  }

  // Quebra em multiplas linhas para legibilidade.
  return parts
    .join(' ')
    .replace(/ -X /g, ' \\\n  -X ')
    .replace(/ -H /g, ' \\\n  -H ')
    .replace(/ --data-raw /g, ' \\\n  --data-raw ');
}

function headersToHarArray(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({
    name,
    value: String(value)
  }));
}

function guessMimeType(headers) {
  const entries = Object.entries(headers || {});
  for (const [k, v] of entries) {
    if (k.toLowerCase() === 'content-type') return String(v);
  }
  return '';
}

// Converte uma lista de entradas em um objeto HAR 1.2.
export function toHar(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  return {
    log: {
      version: '1.2',
      creator: { name: 'FailWatch', version: '0.1.0' },
      entries: list.map((entry) => {
        const started = new Date(entry.startedAt || entry.timestamp || Date.now());
        const reqMime = guessMimeType(entry.requestHeaders);
        const respMime = guessMimeType(entry.responseHeaders);
        return {
          startedDateTime: started.toISOString(),
          time: entry.durationMs || 0,
          request: {
            method: entry.method || 'GET',
            url: entry.url || '',
            httpVersion: 'HTTP/1.1',
            headers: headersToHarArray(entry.requestHeaders),
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: entry.requestBody ? entry.requestBody.length : 0,
            ...(entry.requestBody
              ? {
                  postData: {
                    mimeType: reqMime || 'text/plain',
                    text: entry.requestBody
                  }
                }
              : {})
          },
          response: {
            status: entry.status || 0,
            statusText: entry.statusText || (entry.errorType ? entry.errorType : ''),
            httpVersion: 'HTTP/1.1',
            headers: headersToHarArray(entry.responseHeaders),
            cookies: [],
            content: {
              size: entry.responseBody ? entry.responseBody.length : 0,
              mimeType: respMime || 'text/plain',
              text: entry.responseBody || ''
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: entry.responseBody ? entry.responseBody.length : 0,
            _error: entry.error || undefined
          },
          cache: {},
          timings: { send: 0, wait: entry.durationMs || 0, receive: 0 },
          _failwatch: {
            kind: entry.kind,
            errorType: entry.errorType,
            pageUrl: entry.pageUrl
          }
        };
      })
    }
  };
}

// Gera um relatorio em Markdown pronto para colar num Work Item (Bug) do
// Azure DevOps. Azure Boards renderiza Markdown nos campos de descricao /
// Repro Steps, entao esse texto vira um bug bem estruturado ao colar.
export function toAzureDevOps(entry) {
  const isNet = !!entry.errorType;
  const statusStr = isNet
    ? '0 (' + entry.errorType + ')'
    : entry.status + (entry.statusText ? ' ' + entry.statusText : '');

  const lines = [];
  lines.push('## ' + (entry.method || 'GET') + ' ' + (entry.url || ''));
  lines.push('');
  lines.push('**Falha detectada pelo FailWatch**');
  lines.push('');

  // Tabela de resumo (Azure Boards renderiza tabelas markdown).
  lines.push('| Campo | Valor |');
  lines.push('| --- | --- |');
  lines.push('| Metodo | ' + (entry.method || 'GET') + ' |');
  lines.push('| URL | ' + (entry.url || '') + ' |');
  lines.push('| Status | ' + statusStr + ' |');
  if (isNet && entry.error) lines.push('| Erro | ' + entry.error + ' |');
  lines.push('| Ocorrencias | ' + (entry.count || 1) + ' |');
  lines.push('| Duracao | ' + (entry.durationMs || 0) + ' ms |');
  lines.push('| Pagina | ' + (entry.pageUrl || '—') + ' |');
  lines.push('| Quando | ' + new Date(entry.timestamp || Date.now()).toLocaleString() + ' |');
  lines.push('| Origem | ' + (entry.source || 'inject') + ' |');
  lines.push('');

  if (entry.note) {
    lines.push('### Observacoes');
    lines.push('');
    lines.push(entry.note);
    lines.push('');
  }

  lines.push('### Passos para reproduzir (cURL)');
  lines.push('');
  lines.push('```bash');
  lines.push(toCurl(entry));
  lines.push('```');
  lines.push('');

  if (entry.requestBody) {
    lines.push('### Request body');
    lines.push('');
    lines.push('```');
    lines.push(clampForReport(entry.requestBody));
    lines.push('```');
    lines.push('');
  }

  if (entry.responseBody) {
    lines.push('### Response body');
    lines.push('');
    lines.push('```');
    lines.push(clampForReport(entry.responseBody));
    lines.push('```');
    lines.push('');
  }

  const reqH = Object.entries(entry.requestHeaders || {});
  if (reqH.length) {
    lines.push('### Request headers');
    lines.push('');
    for (const [k, v] of reqH) lines.push('- **' + k + '**: ' + v);
    lines.push('');
  }

  const respH = Object.entries(entry.responseHeaders || {});
  if (respH.length) {
    lines.push('### Response headers');
    lines.push('');
    for (const [k, v] of respH) lines.push('- **' + k + '**: ' + v);
    lines.push('');
  }

  if (entry.screenshot) {
    lines.push('### Screenshot');
    lines.push('');
    lines.push('> Screenshot da aba capturado no momento da falha. Anexe a imagem');
    lines.push('> ao Work Item (use "Exportar screenshot" no FailWatch).');
    lines.push('');
  }

  lines.push('---');
  lines.push('_Gerado automaticamente pelo FailWatch._');

  return lines.join('\n');
}

function clampForReport(text) {
  const MAX = 4000;
  if (typeof text !== 'string') return '';
  return text.length > MAX ? text.slice(0, MAX) + '\n… [truncado]' : text;
}

// Faz o download de um dataURL (ex.: screenshot JPEG) como arquivo.
export function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
