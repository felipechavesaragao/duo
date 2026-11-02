# duo

Claude Code e Codex na mesma janela do terminal.

Você conversa com os dois ao mesmo tempo: manda uma mensagem para um, para o outro ou para os dois, e cada um vê o que você e o outro disseram. Por baixo rodam o próprio Claude Code e o próprio Codex, com os seus logins. O duo é só a tela que junta os dois.

```
/todos ›  qual banco usar para guardar sessões de um CLI pequeno?

● Claude
  ...
● Codex
  ...
```

## Requisitos

- Node 20 ou mais novo
- [Claude Code](https://code.claude.com/docs/en/overview) instalado e logado (`claude` no terminal)
- [Codex CLI](https://github.com/openai/codex) instalado e logado (`codex` no terminal)

Não precisa de chave de API: o duo usa os mesmos logins que você já usa no Claude Code e no Codex.

Testado no Windows 11 com Node 24, Claude Code 2.1.316 e Codex CLI 0.166.0.

## Instalar

```bash
git clone https://github.com/felipechavesaragao/duo.git
cd duo
npm install
npm run build
npm link
```

Depois é só rodar `duo` na pasta do projeto em que você quer trabalhar. Os dois agentes trabalham nessa pasta.

## Comandos

| comando | o que faz |
|---|---|
| `/claude <msg>` | manda só para o Claude (atalhos: `/c`, `/cla`) |
| `/codex <msg>` | manda só para o Codex (atalhos: `/x`, `/fog`) |
| `/todos <msg>` | manda para os dois, em paralelo (ou `/ambos`) |
| `<msg>` | manda para o destino padrão, que aparece antes do `›` |
| `/codex` | sem mensagem: muda o destino padrão |
| `/cla /init` | manda um comando do próprio agente (o `/init` vai para o Claude) |
| `/brain /cla <msg>` | o Claude responde, o Codex avalia, e eles revezam até concordarem (no máximo 6 respostas; `/brain /fog` faz o Codex começar) |
| `/parar` | encerra o brain depois da resposta em andamento |
| `/compartilhado` | (padrão) cada um vê o que você e o outro disseram |
| `/privado` | só quem recebe vê; o outro não fica sabendo nem depois |
| `/novo` | começa conversas novas com os dois |
| `/limpar` | limpa a tela |
| `/ajuda` | mostra os comandos |
| `/sair` | encerra (ou Ctrl+C) |

`@` funciona no lugar de `/` para chamar os agentes: `@fog`, `@todos`...

No `/todos`, os dois respondem ao mesmo tempo e nenhum vê a resposta do outro àquela mensagem. Cada um fica sabendo da resposta do outro na mensagem seguinte.

## Opções

```
duo [opções]

  -c, --continuar                  continua a última conversa desta pasta
  --para <claude|codex|todos>      destino padrão inicial (padrão: claude)
  --claude-permission <modo>       default | acceptEdits | plan | bypassPermissions
  --codex-sandbox <modo>           read-only | workspace-write | danger-full-access
  --claude-model <modelo>          modelo do Claude
  --codex-model <modelo>           modelo do Codex
  --yolo                           força os dois sem restrição
  -h, --help                       ajuda
```

As conversas ficam salvas em `~/.duo/`. O `duo -c` retoma a última conversa da pasta: a tela, o modo e a memória de cada agente.

## ⚠️ Permissões

O duo não mostra pedidos de permissão. Por padrão:

- o **Claude** segue o modo de permissão do seu `settings.json`;
- o **Codex** roda **sem sandbox** e sem pedir aprovação.

Ou seja, os dois podem editar arquivos e rodar comandos na pasta sem perguntar. Para restringir, use `--claude-permission default` e `--codex-sandbox read-only` (ou `workspace-write`).

## Como funciona

- **Claude:** um processo `claude -p` em stream-json fica vivo durante a sessão.
- **Codex:** um processo `codex app-server` fica vivo durante a sessão. O app-server ainda é marcado como experimental pelo Codex, então uma versão nova do Codex pode quebrar o duo.
- Enquanto o duo estiver aberto, a conversa do Codex fica presa a ele. Se você tentar retomar a mesma conversa em outro terminal, o Codex recusa até o duo fechar.

## Desenvolvimento

```bash
npm test            # testes (com agentes de mentira)
npm run typecheck
npm run dev         # roda sem compilar
npm run smoke       # teste rápido com o Claude e o Codex de verdade
```

## Aviso

Projeto pessoal, sem relação com a Anthropic ou a OpenAI. Claude e Claude Code são marcas da Anthropic; Codex é marca da OpenAI.

## Licença

[MIT](LICENSE)
