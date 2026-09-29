# FailWatch — Network Failure Recorder

Uma extensão de navegador (Manifest V3) que grava **automaticamente** as requisições
`fetch`/`XHR` que **falharam** enquanto você navega — sem precisar ter o DevTools
aberto no momento do erro. Feita para o dia a dia de QA: quando algo quebra em
ambiente, a falha já está registrada, com detalhe suficiente pra reproduzir.

## Por que existe

Validando algo em ambiente, é comum esquecer de abrir o DevTools antes do erro
acontecer. Aí a requisição que falhou já passou e reproduzir vira um custo. O
FailWatch fica escutando em background e guarda **apenas** o que deu errado.

## O que captura

- Requisições `fetch` e `XMLHttpRequest` feitas pela página.
- **Falha** = resposta HTTP com status `>= 400` **ou** erro de rede
  (DNS, CORS, offline, timeout, abort). O limiar é configurável.
- Para cada falha guarda: método, URL, headers de request/response,
  corpo de request, **corpo de response completo**, status, duração e a página
  de origem.

> Nota sobre escopo: a captura usa interceptação de `fetch`/`XHR` no contexto da
> página, que é o que permite pegar o **corpo da resposta** (a API `webRequest`
> do MV3 não expõe response bodies). Isso cobre chamadas de API de apps web
> modernos. Não captura navegação de documento, imagens, etc.

## Onde ver as falhas

- **Popup**: clique no ícone da extensão para um histórico rápido.
- **Painel do DevTools**: abra o DevTools e vá na aba **FailWatch** para a
  mesma visão, com mais espaço.

Ambos mostram lista + detalhes no estilo DevTools (headers, payload, response,
timing) e compartilham o mesmo armazenamento.

## Recursos

- Badge no ícone com a contagem de falhas.
- Filtro por URL, status, método.
- **Rede de segurança via `webRequest`**: além da interceptação de `fetch`/`XHR`,
  a extensão usa a API `webRequest` como backup para capturar falhas que a
  injeção não vê (ex.: requisições fora do contexto da página). Essas entradas
  não trazem o corpo da resposta (limitação do MV3), mas garantem que nada
  passe despercebido. Falhas capturadas pelas duas fontes são deduplicadas.
- **Agrupamento de falhas repetidas**: o mesmo endpoint quebrando várias vezes
  vira uma linha só, com contador `×N`. IDs na URL (`/users/123`, UUIDs, hashes)
  são normalizados, então `/users/123` e `/users/456` caem no mesmo grupo. O
  detalhe mostra primeira e última ocorrência.
- **Regras de captura por domínio**: modo allowlist (só os domínios listados),
  denylist (todos menos os listados) ou todos. Padrões aceitam coringa (`*`),
  ex.: `*.meu-app.com`.
- **Anotação por falha**: um campo de nota persistido em cada falha, para
  registrar contexto do bug.
- **Copiar para Azure DevOps**: gera um relatório em Markdown pronto para colar
  num Work Item (Bug) do Azure Boards — resumo, cURL de repro, request/response,
  sua anotação e referência ao screenshot.
- **Screenshot no momento da falha** (opcional): captura a aba visível quando o
  erro ocorre, com throttle configurável. Exibido no detalhe e exportável.
- **Copiar como cURL** em cada falha.
- **Exportar HAR** (uma falha ou todas) — reimporte no DevTools de qualquer dev.
- **Redação de headers sensíveis** (`Authorization`, `Cookie`, etc.) antes de
  guardar, importante ao compartilhar dumps.
- Limite configurável de falhas guardadas (descarta as mais antigas).

## Instalação (modo desenvolvedor)

Funciona em Chrome, Edge, Brave e outros baseados em Chromium.

1. Abra `chrome://extensions` (ou `edge://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta deste projeto
   (a que contém o `manifest.json`).
4. Fixe o ícone do FailWatch na barra, se quiser.

## Como testar rápido

1. Abra qualquer site.
2. No console do DevTools, dispare uma falha proposital:
   ```js
   fetch('https://httpbin.org/status/500');        // erro HTTP 5xx
   fetch('https://dominio-que-nao-existe.abc/x');   // erro de rede
   ```
3. Clique no ícone da extensão (ou abra a aba **FailWatch** no DevTools):
   as duas falhas devem aparecer no histórico. Clique numa delas para ver os
   detalhes, copiar como cURL ou exportar HAR.

## Configuração

Clique no ⚙ dentro do popup/painel (ou em "Opções" na página de extensões) para
ajustar:

- Status HTTP mínimo para capturar (padrão `400`).
- Capturar erros de rede (padrão ligado).
- Rede de segurança via `webRequest` (padrão ligado). Ao ligar/desligar,
  recarregue a extensão para aplicar.
- Regras por domínio: todos / allowlist / denylist + padrões com coringa.
- Capturar screenshot no momento da falha (padrão desligado) + throttle.
- Máximo de falhas guardadas (padrão `500`).
- Tamanho máximo de cada corpo (padrão `100000` caracteres).
- Redação de headers sensíveis e a lista de headers redigidos.

## Permissões e por quê

- `storage`: guarda as configurações.
- `webRequest` + `host_permissions: <all_urls>`: rede de segurança que observa
  o status/erro das requisições (sem ler conteúdo de resposta).
- `tabs`: necessário para `captureVisibleTab` (screenshot da aba na falha).

Nada é transmitido para fora do navegador. Veja a seção Privacidade.

## Estrutura do projeto

```
manifest.json
icons/                      icones gerados por tools/make-icons.mjs
src/
  injected/interceptor.js   sobrescreve fetch/XHR no contexto da pagina
  content/content-script.js injeta o interceptor e faz a ponte de mensagens
  background/
    service-worker.js       filtra, redige, persiste, badge, roteia mensagens
    storage.js              camada IndexedDB
  shared/
    constants.js            tipos de mensagem, defaults, redacao, truncamento
    settings.js             leitura/escrita de settings (chrome.storage)
  ui/
    ui.css                  estilo compartilhado (tema escuro)
    history.js              logica de lista + detalhe (popup e devtools)
    export.js               copiar cURL, exportar HAR, relatorio Azure DevOps
    popup.html / popup.js
    panel.html / panel.js   painel do DevTools
    options.html / options.js
  devtools/
    devtools.html / devtools.js  registra a aba do DevTools
tools/make-icons.mjs        gerador de icones (node tools/make-icons.mjs)
```

## Privacidade

Tudo fica **local** no seu navegador (IndexedDB). Nada é enviado para nenhum
servidor. Os dados só saem se você exportar um HAR manualmente.

## Ideias futuras

- Integração direta com a API do Azure DevOps para criar o Work Item com um
  clique (hoje o fluxo é copiar/colar).
- Anexar o screenshot automaticamente ao Work Item.
- Realce de diff entre ocorrências do mesmo grupo.
- Exportar/importar as configurações.

## Licença

MIT. Veja [LICENSE](LICENSE).
