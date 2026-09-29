# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/)
e o projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.1.0] - 2026-09-29

### Adicionado

- Captura automática de requisições `fetch`/`XHR` que falharam (HTTP >= 400 ou
  erro de rede), sem depender do DevTools estar aberto.
- Armazenamento local em IndexedDB com limite configurável de entradas.
- Popup e painel dedicado do DevTools (aba **FailWatch**) compartilhando o
  mesmo histórico, com detalhes no estilo DevTools (headers, payload, response,
  timing).
- Badge no ícone com a contagem de falhas.
- Filtro por URL, status e método.
- Rede de segurança via `chrome.webRequest` para falhas que a interceptação de
  `fetch`/`XHR` não vê, com deduplicação entre as fontes.
- Agrupamento de falhas repetidas, com normalização de IDs na URL (numéricos,
  UUIDs e hashes) e contador de ocorrências.
- Regras de captura por domínio: allowlist, denylist ou todos, com padrões
  coringa (`*`).
- Anotação por falha, persistida junto do registro.
- Exportação: copiar como cURL, exportar HAR (uma ou todas) e copiar relatório
  em Markdown pronto para um Work Item (Bug) do Azure DevOps.
- Captura opcional de screenshot da aba no momento da falha, com throttle
  configurável.
- Redação de headers sensíveis (`Authorization`, `Cookie`, etc.) antes de
  guardar.
- Página de opções para todas as configurações.

[0.1.0]: https://example.com/failwatch/releases/tag/v0.1.0
