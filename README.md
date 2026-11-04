# duo

Claude Code e Codex na mesma janela: no terminal ou numa janela própria (`duo --gui`).

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

Não precisa de chave de API: o duo usa os mesmos logins que você já usa no Claude Code e no Codex. Ele roda o Claude Code com o seu ambiente, como o terminal: se a variável `ANTHROPIC_API_KEY` estiver definida, o Claude Code pode usá-la e cobrar pela API em vez do seu login. O duo avisa quando vê isso.

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
| `@cla /` | mostra a lista de comandos do Claude (`@fog /`: as skills do Codex); digite para filtrar, Tab completa |
| `/brain /cla <msg>` | o Claude responde, o Codex avalia, e eles revezam até concordarem (no máximo 6 respostas; `/brain /fog` faz o Codex começar) |
| `/parar` | encerra o brain depois da resposta em andamento |
| `/compartilhado` | (padrão) cada um vê o que você e o outro disseram |
| `/privado` | só quem recebe vê; o outro não fica sabendo nem depois |
| `/novo` | começa conversas novas com os dois |
| `/limpar` | limpa a tela |
| `/ajuda` | mostra os comandos |
| `/sair` | encerra (ou Ctrl+C) |

`@` funciona no lugar de `/` para chamar os agentes: `@fog`, `@todos`...

**Comandos de cada agente**: o duo pede a lista a cada um quando abre. A do Claude é a que o `claude -p` informa (`/compact`, `/context`, `/usage`, as skills e os comandos de plugin); os poucos que só funcionam na tela do terminal, como `/focus`, respondem que não estão disponíveis. O Codex não aceita comandos `/` fora do terminal dele, então a lista dele são as skills ligadas: `@fog /nome-da-skill <texto>` chama a skill, como o `$nome-da-skill` no terminal do Codex. Um comando vai puro, sem o contexto da janela; o que o agente perdeu vai junto da mensagem seguinte.

No `/todos`, os dois respondem ao mesmo tempo e nenhum vê a resposta do outro àquela mensagem. Cada um fica sabendo da resposta do outro na mensagem seguinte.

**Um chama o outro sozinho**: o duo dá ao Claude a ferramenta `falar_com_codex` e ao Codex a `falar_com_claude`, e avisa os dois de que elas existem. A mensagem aparece na janela como `[para o Codex] …` (ou `[para o Claude] …`), vira um turno normal de quem foi chamado (na fila dele, com o contexto da janela) e a resposta volta para quem chamou, que continua de onde estava. Quem está esperando uma resposta não pode ser chamado de volta: o duo recusa na hora, em vez de deixar os dois travados um esperando o outro. Numa revisão, quem chamou insiste até os dois convergirem ou ficar claro que não vão convergir (aí a divergência vai para você); quem foi chamado termina dizendo se concorda ou o que ainda falta. Se o projeto tem um protocolo de revisão próprio, vale o dele.

**Onde editar**: no mesmo aviso, o duo diz aos dois que mudança de código fica separada da master. Antes de editar código num repositório git, cada um cria um worktree (`git worktree add`, numa pasta própria e com branch própria) e edita nele; a sessão continua na pasta onde o duo abriu. A mudança só volta para a master/main quando você mandar commitar, e o worktree é removido depois. Perguntas e leituras não criam worktree. O aviso vai em qualquer pasta onde você abrir o duo, e o `CLAUDE.md` ou o `AGENTS.md` do projeto vence quando diz outra coisa.

Quando um subagente ou comando do Claude em segundo plano termina, ele continua sozinho, sem mensagem sua. Esse turno aparece na janela como os outros, e a resposta entra no contexto do Codex.

**Remote Control**: se o seu settings do Claude Code tem `"remoteControlAtStartup": true`, o duo liga o Remote Control na conversa do Claude, como o terminal faria (o `claude -p` que o duo usa não liga sozinho). A conversa aparece no app desktop e no claude.ai/code, e o link vai para a janela. O que você digitar lá aparece no duo como `[pelo app, para o Claude] …`, a resposta dele também, e o Codex recebe as duas como contexto.

O Codex só recebe a ferramenta numa conversa nova: o app-server aceita ferramentas do cliente só ao abrir a conversa, não ao retomar. Uma conversa do Codex aberta por uma versão anterior do duo continua sem ela até um `/novo`.

O **rodapé** mostra, para cada um, o modelo, os tokens no contexto da conversa (com o tamanho da janela do modelo) e quantos subagentes estão rodando.

## Janela (`duo --gui`)

`duo --gui` abre a mesma conversa numa janela própria em vez do terminal: o Edge ou o Chrome em modo app (sem abas nem barra de endereço) ou, sem nenhum dos dois, o navegador padrão. O terminal fica só com o endereço; `/sair` na janela (ou **Encerrar o duo**) ou Ctrl+C no terminal encerra. `duo --gui -c` retoma a última conversa da pasta, inclusive uma do terminal.

- **Barra lateral**: nova conversa, brain, limpar a tela, comandos, e como cada agente está (livre, trabalhando, pede permissão). Clicar num agente o torna o destino padrão.
- **Conversa**: as suas mensagens à direita, as respostas com o nome de quem fala, as ações seguidas de um agente agrupadas (um clique abre a lista), e quem está trabalhando, com o tempo.
- **Caminho do turno**: cada ação diz como acabou: ✓, ✗ com o código de saída do comando ou o motivo (você negou, recusado, o erro), ou – quando você parou o agente, ou o turno (ou o próprio duo) acabou antes dela. Uma edição diz se o arquivo foi criado, alterado, apagado ou movido, com o caminho relativo à pasta. Um clique na ação abre o comando inteiro e a lista de arquivos, e o grupo diz quantas falharam. No Windows, o código de um comando do Codex é o que devolve o PowerShell que o embrulha, que nem sempre é o do programa (um `node` que sai com 3 aparece como 1). No terminal aparece só o que não deu certo (`↳ saiu com código 3`).
- **Caixa de texto**: aceita tudo o que o terminal aceita (`/cla`, `@fog /`, `/brain`, `/privado`...). Digitar só `/` mostra os comandos do duo, cada um com o que faz: o que você digita depois filtra por qualquer nome deles (`/cod` acha o `/codex`), e Tab ou um clique completa. O **+** começa um comando do Claude, uma skill do Codex ou um brain; embaixo dela ficam o destino padrão e o modo. Enter manda, Shift+Enter quebra a linha.
- **Modelo**: ao lado do destino, um chip por agente (dois com "os dois") mostra o modelo e o esforço que ele está usando, e "rápido" no Codex. Um clique abre os modelos que o próprio agente informa, o submenu de esforço com os níveis daquele modelo e, só no Codex, o modo rápido (o Claude não liga o rápido fora do terminal dele). A troca não abre turno: no Claude vale na hora, no Codex a partir da próxima mensagem. Ela vale também depois do `/novo` ou de uma queda, mas não depois de fechar o duo. Trocar de modelo leva junto o que o novo não tem (o esforço vai para o padrão dele, o rápido desliga), e a conversa diz o que ficou ou por que não trocou.
- **Print**: Ctrl+V cola um print (até 5 por mensagem), que aparece em miniatura antes de ir. Ele vai junto da mensagem, ou sozinho para o destino padrão. O Claude e o Codex recebem a imagem. No modo compartilhado, o outro fica sabendo que houve um print, mas não o vê. Os prints ficam em `~/.duo/imagens/`, e a conversa retomada mostra os prints de novo.
- **Pedido de permissão**: vira um cartão com **Permitir** e **Negar**.
- **Painel**: em **Rodando agora**, o turno de cada um com o tempo e o que ele está esperando: a sua permissão, o outro agente (quando o chamou pela ferramenta do duo) ou uma ferramenta, com qual e há quanto tempo (`rodando: Bash npm test · há 3min`). Sem nada disso e sem sinal do processo há mais de 2 minutos, o turno ganha um aviso: pode estar travado. Também aparece o que ele pôs em segundo plano (subagentes como o devil-advocate, comandos), com o que cada um está fazendo. Mais abaixo, a pasta, o modo (compartilhado ou privado) e o contexto de cada um.
- **Parar**: o botão ao lado de cada agente em **Rodando agora** para só aquele agente. O mesmo parar fica na caixa de texto: enquanto o agente do destino padrão (o "Para …" embaixo da caixa, não um `@fog` escrito na mensagem) trabalha, o **Esc** o para, e o botão de mandar vira **■** quando a caixa está vazia (com texto, ele continua mandando, para a fila; com "os dois", para os dois que estiverem trabalhando). O texto que ainda está na caixa fica nela, então dá para parar e mandar a correção em seguida. O que você já mandou foi para a fila dele, e o parar descarta a fila; por isso o Esc não faz nada enquanto uma mensagem ainda está a caminho do duo. Ele interrompe o que o agente está fazendo (a mensagem do duo ou um turno que ele abriu sozinho) e descarta as mensagens na fila dele. O outro agente segue, e a conversa fica: a próxima mensagem continua nela, e o agente sabe que foi parado. Se o outro estava esperando a resposta dele pela ferramenta do duo, fica sabendo na hora que você o parou. Se era ele quem esperava o outro, deixa de esperar, mas o outro responde mesmo assim, e a resposta vai para ele junto do contexto da próxima mensagem compartilhada. No Claude, um comando em andamento leva alguns segundos para parar; se a resposta chegar nesse meio, ela fica na conversa, mas nada segue dela (o brain, por exemplo, já parou).

A janela é uma página servida pelo próprio duo só para o seu computador (`127.0.0.1`). Quem fala com ela manda nos agentes, então ela só abre com a chave que vai no endereço que o duo mostra. A chave vira um cookie e sai do endereço, e a página não aceita pedido de outro site. Pode abrir o mesmo endereço em mais de uma janela: todas mostram a mesma conversa.

## Opções

```
duo [opções]

  -c, --continuar                  continua a última conversa desta pasta
  --gui                            abre numa janela própria em vez do terminal
  --para <claude|codex|todos>      destino padrão inicial (padrão: claude)
  --claude-permission <modo>       default | acceptEdits | plan | bypassPermissions
  --codex-sandbox <modo>           read-only | workspace-write | danger-full-access
  --claude-model <modelo>          modelo do Claude
  --codex-model <modelo>           modelo do Codex
  --yolo                           Claude em bypassPermissions e Codex sem sandbox
                                   (as regras deny e ask do settings do Claude continuam valendo)
  -h, --help                       ajuda
```

As conversas ficam salvas em `~/.duo/`. O `duo -c` retoma a última conversa da pasta: a tela, o modo e a memória de cada agente.

## ⚠️ Permissões

Por padrão:

- o **Claude** segue o modo de permissão do seu `settings.json`. Quando o terminal dele perguntaria (uma regra `ask` como `Bash(git push:*)`, ou o modo `default`), a pergunta aparece no duo: no terminal a caixa de texto vira `permitir? s/n`, e o que você estava digitando fica guardado; na janela, vira um cartão com **Permitir** e **Negar**. Regras `deny` continuam negando sem perguntar;
- o **Codex** roda **sem sandbox** e sem pedir aprovação.

Ou seja, fora das regras `ask` do Claude, os dois podem editar arquivos e rodar comandos na pasta sem perguntar. Para restringir, use `--claude-permission default` (o duo pergunta antes de cada edição ou comando do Claude que as suas regras `allow` não liberem) e `--codex-sandbox read-only` (ou `workspace-write`).

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
