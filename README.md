# A Ponte: Central de Salas (agente A2A com MCP por dentro)

Entrega do desafio "A Ponte" (MBA Engenharia de Software com IA, curso de MCP e A2A). O enunciado original esta no historico do repositorio (`git show 263f17e:README.md`).

Dois processos Node.js (TypeScript, ESM, rodando direto com `tsx`, sem passo de build), que so conversam por HTTP:

| processo | pasta | porta padrao | endpoint |
|---|---|---|---|
| servidor MCP "Central de Salas" (Streamable HTTP, stateless) | `servidor-mcp/` | `7301` | `/mcp` |
| agente "Central de Salas" (host MCP por dentro, servidor A2A v1.0 por fora) | `agente/` | `7300` | `/a2a` e `/.well-known/agent-card.json` |

`dados/`, `validador/` e `exemplos/` estao exatamente como no starter. O vocabulario do dominio (Sala, Reserva, Conflito, Alternativa, Pausa, Escolha, Recusa...) esta em `GLOSSARY.md`.

## Como rodar

Requisitos: Node.js 20.6 ou superior e npm (testado com Node 22; `npm test` usa glob no `node --test`, que pede Node 21 ou superior); Python 3.10 ou superior para o validador. Confira com `node --version` e `python3 --version`. No macOS o `/usr/bin/python3` do sistema e 3.9: nesse caso use um Python mais novo no lugar de `python3` nos comandos abaixo (por exemplo `python3.13` do Homebrew).

### 1. Clonar e instalar

```bash
git clone https://github.com/mathewsjts/desafio-a2a-com-mcp.git
cd desafio-a2a-com-mcp
npm ci
```

`npm ci` instala exatamente o `package-lock.json` commitado. Todas as versoes estao travadas sem `^` nem `~` (`.npmrc` com `save-exact=true`).

### 2. Gerar o segredo do `requestState`

O servidor MCP recusa subir sem `REQUEST_STATE_SECRET` (ou com menos de 32 bytes). Gere um valor seu e exporte no terminal em que o servidor MCP vai rodar. Nunca commite o valor; nada e lido de `.env`.

```bash
export REQUEST_STATE_SECRET="$(python3 -c "import secrets; print(secrets.token_hex(32))")"
```

O agente nao usa o segredo.

### 3. Subir os dois processos (um terminal para cada)

Terminal 1, servidor MCP (o stderr dele e o log de requests: uma linha JSON por request com `method`, `id` e `traceparent`):

```bash
export REQUEST_STATE_SECRET="$(python3 -c "import secrets; print(secrets.token_hex(32))")"   # se ainda nao exportou neste terminal
npm run mcp
```

Terminal 2, agente:

```bash
npm run agente
```

Cada processo escreve uma linha no stderr quando esta escutando (`servidor MCP central-de-salas em http://127.0.0.1:7301/mcp` e `agente central-de-salas em http://127.0.0.1:7300/a2a ...`). Os dois escutam so em `127.0.0.1`. A ordem de subida nao importa: o agente nao fala com o servidor MCP ate a primeira Task.

### 4. Rodar o validador

Terminal 3:

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

**O validador exige processos recem-iniciados.** Os checks criam Reservas em sequencia, e as Reservas ficam em memoria no servidor MCP: uma segunda execucao contra os mesmos processos falha. Antes de cada execucao, pare os dois processos (Ctrl+C) e suba de novo.

Atalho com um comando so (sobe os dois processos novos como filhos, roda o validador com o primeiro Python 3.10+ que achar, derruba tudo e sai com o codigo do validador):

```bash
npm run validar
```

Ele aborta se `7300` ou `7301` ja estiverem ocupadas, usa o `REQUEST_STATE_SECRET` do ambiente (ou um aleatorio so para a execucao) e grava o stderr de cada processo em `validar-servidor-mcp.log` e `validar-agente.log` (ignorados pelo git). `PYTHON=/caminho/python3.12` escolhe o interpretador.

### Outros comandos

```bash
npm test            # testes (node:test), sobem processos reais em portas aleatorias
npm run typecheck   # tsc sem gerar build
```

Variaveis de ambiente (todas opcionais, menos o segredo):

| variavel | quem le | padrao |
|---|---|---|
| `REQUEST_STATE_SECRET` | servidor MCP | obrigatoria, no minimo 32 bytes |
| `REQUEST_STATE_TTL_SECONDS` | servidor MCP | `600` (existe para os testes de expiracao) |
| `MCP_PORT` | servidor MCP | `7301` |
| `AGENT_PORT` | agente | `7300` |
| `AGENT_CARD_URL` | agente (URL publicada no card) | `http://127.0.0.1:7300/a2a` |
| `MCP_URL` | agente (onde esta o servidor MCP) | `http://127.0.0.1:7301/mcp` |

### Roteiro manual (opcional)

Com processos recem-iniciados:

```bash
curl -s http://localhost:7300/.well-known/agent-card.json

# Pedido de sala ocupada: a Task fica em TASK_STATE_INPUT_REQUIRED com "alternativas: sala-fusca, sala-mirante"
curl -s http://localhost:7300/a2a -H 'Content-Type: application/json' \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"msg-1","role":"ROLE_USER","parts":[{"text":"reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty"}]}}}'

# Continuacao (troque <taskId> pelo id devolvido acima); escolha=recusar termina em TASK_STATE_CANCELED
curl -s http://localhost:7300/a2a -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"SendMessage","params":{"message":{"messageId":"msg-2","role":"ROLE_USER","taskId":"<taskId>","parts":[{"text":"escolha=sala-mirante"}]}}}'

curl -s http://localhost:7300/a2a -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"GetTask","params":{"id":"<taskId>"}}'
```

No terminal do servidor MCP aparecem, nessa ordem, `tools/list`, `resources/read` e o par de `tools/call` (o retry com id diferente do inicial), todos com o trace-id `4bf92f3577b34da6a3ce929d0e0e4736`.

## Onde a ponte acontece

A ponte e um unico modulo do agente, `agente/src/conducao.ts`, que liga o host MCP (`agente/src/host-mcp.ts`) a maquina de estados da Task (`agente/src/task.ts`). O agente nao tem regra de sala: Conflito, Politica de uso e Alternativas sao decididos so pelo servidor MCP.

**`input_required` vira `TASK_STATE_INPUT_REQUIRED`.** O `tools/call reservar_sala` sai por `client.request(..., { allowInputRequired: true })` em `agente/src/host-mcp.ts:97-106`, sem handler de elicitation e com `inputRequired: { autoFulfill: false }`, entao o agente recebe o `input_required` cru. Em `agente/src/conducao.ts:60`, `interpretarResultado` reconhece o resultado com `isInputRequiredResult(r)` e `lerPedidoDeEscolha` (`conducao.ts:38-47`) tira dele so tres coisas: a chave unica de `inputRequests`, o `enum` (ou `const`) de `requestedSchema.properties.sala` na ordem do servidor e o `requestState` como string opaca. Em `agente/src/conducao.ts:92-95` (`aplicar`, `case 'pausa'`) a linha 94 guarda `task.continuacao = { chave, requestState, alternativas, argumentos }` no store e a linha 95 faz `responder(task, 'TASK_STATE_INPUT_REQUIRED', 'alternativas: ' + ids.join(', '))`. A `continuacao` nunca vai para o wire: `paraWire` (`agente/src/task.ts`) serializa so `id`, `contextId`, `status`, `history` e `artifacts`.

**O `requestState` volta ao servidor.** O `SendMessage` com `taskId` de uma Task em `TASK_STATE_INPUT_REQUIRED` chega em `agente/src/entrada.ts:77-86` e vai para `conducao.continuar` (`agente/src/conducao.ts:151-176`). Uma resposta que nao e `escolha=recusar` nem `escolha=<id do enum>` mantem a Pausa e repete a linha de alternativas, sem chamar o MCP. Uma resposta valida move a Task para `TASK_STATE_WORKING` antes do primeiro `await` (uma segunda continuacao concorrente recebe `-32004`) e, em `agente/src/conducao.ts:171`, chama `host.reservarSala(argumentos, task.traceId, { inputResponses, requestState })`, com `inputResponses = { [chave]: { action: 'accept', content: { sala } } }` ou `{ [chave]: { action: 'decline' } }`. Em `agente/src/host-mcp.ts:101` esses dois campos sao espalhados em `params` do `tools/call`, ao lado dos `arguments` originais, e o SDK gera um id de JSON-RPC novo. O `requestState` e ecoado byte a byte; o agente nunca o decodifica. O trace-id do retry e o da Task (do `traceparent` do primeiro `SendMessage`), com span-id novo.

Do outro lado, `servidor-mcp/src/servidor.ts:146-147` le o estado verificado com `ctx.mcpReq.requestState<Selado>()` e, se ele existe, `concluirEscolha` (`servidor.ts:79-91`) conclui a partir do payload selado.

## Decisoes tecnicas

### `requestState`: protecao e validade

- **Codec.** `createRequestStateCodec` do proprio SDK (`servidor-mcp/src/estado.ts`): HMAC-SHA256, so assinado, nao cifrado (o cliente consegue ler o payload, nao consegue altera-lo). A verificacao e do SDK, via `requestState: { verify: codec.verify }` no `McpServer`. Adulterado (MAC, corpo ou lixo) ou expirado: `-32602`.
- **Validade.** TTL de 10 minutos (`ttlSeconds: 600`, campo `exp` do envelope). `REQUEST_STATE_TTL_SECONDS` so existe para os testes de expiracao.
- **Amarrado a tool.** O `bind` do codec usa `tools/call` + o header `Mcp-Name` (que o SDK ja exige igual a `params.name`). Um estado emitido por `reservar_sala` e recusado com `-32602` em outra tool ou metodo.
- **Segredo.** `REQUEST_STATE_SECRET`, nunca no codigo. `servidor-mcp/src/main.ts` confere, antes de abrir a porta, que ele existe e tem pelo menos 32 bytes; senao escreve `servidor MCP nao subiu: <motivo>` no stderr e sai com codigo 1.
- **Sem estado no servidor.** O payload selado leva o Pedido normalizado (`sala`, `inicio`, `fim`, `responsavel`) e as Alternativas oferecidas. Nada fica em memoria entre o `input_required` e o retry, entao um retry funciona depois de reiniciar o servidor MCP (com o mesmo segredo).

### Retry: selado vence, disponibilidade revalidada

- No retry, os `arguments` reenviados pelo cliente sao ignorados: valem os valores selados. Um retry com argumentos adulterados reserva o que foi selado, nunca o adulterado.
- A Escolha so e aceita se estiver entre as Alternativas seladas **e** a Sala ainda estiver livre agora. Caso contrario o servidor recalcula as Alternativas e devolve um novo `input_required` (ou `Sem alternativas disponiveis no intervalo`).
- `action` `decline` ou `cancel`: resultado `complete`, sem `isError`, com `reservado: false` e `motivo: "recusado"`.
- O estado nao e de uso unico. Um replay de um retry aceito nao duplica a Reserva, porque a disponibilidade e revalidada: a Sala escolhida ja esta ocupada e o servidor volta a pedir Escolha.

### Estado das Tasks

- Store em memoria no agente (`criarStoreDeTasks`, `agente/src/task.ts`): um `Map` do id da Task para `id`, `contextId`, estado, historico, artifacts, trace-id, versao da Politica lida e, so durante a Pausa, a `continuacao` MCP (chave, `requestState`, argumentos originais, Alternativas). Reiniciar o agente perde as Tasks, inclusive as pausadas.
- O estado pausado e por Task: cada Task tem a sua `continuacao`, entao duas Pausas simultaneas concluem cada uma com a sua Reserva.
- A maquina de estados e a tabela literal `TRANSICOES` em `agente/src/task.ts`. Toda mudanca passa por `mover`, que lanca em transicao fora da tabela. `COMPLETED`, `FAILED` e `CANCELED` nao tem saida; `SendMessage` para Task terminal recebe `-32004` e a Task nao muda.
- `SendMessage` e sincrono (sem streaming, fora de escopo): a resposta ja traz a Task no estado em que ela para (Pausa ou terminal). `SUBMITTED` e `WORKING` acontecem dentro do request e um `GetTask` concorrente os enxerga.
- As Reservas do servidor MCP tambem ficam em memoria (carregadas de `dados/` na subida, ids `res-NNNN` sequenciais), como o enunciado permite.

### Servidor MCP: entrada e SDK

- `@modelcontextprotocol/server` 2.4.0 com `createMcpHandler` (`responseMode: 'json'`, `legacy: 'reject'`, um `McpServer` por request) atras do adaptador `@modelcontextprotocol/node` 2.1.2.
- **Pre-checagem de `_meta` ausente.** Um wrapper fino em `node:http` (`servidor-mcp/src/entrada.ts`) fica na frente do SDK: registra a linha de log e recusa com `-32602`/HTTP 400 qualquer request sem `io.modelcontextprotocol/protocolVersion` ou sem `io.modelcontextprotocol/clientCapabilities` no `_meta`. Motivo: sem `_meta` e sem header `MCP-Protocol-Version`, o SDK classifica o request como legado e responde `-32022` ("Unsupported protocol version: the request did not name a protocol version"), e o enunciado exige `-32602`. Com `_meta` parcial o SDK ja responde `-32602`/400 sozinho; a pre-checagem cobre os tres casos do mesmo jeito. Todo o resto (`-32020` de header espelhado, tool ou URI inexistente, `requestState` invalido, `-32021`) e do SDK.
- **`{"elicitation": {}}` e aceito.** A checagem de capability e do SDK: `{}` ou `{"elicitation": {"url": {}}}` recebem `-32021` com `data.requiredCapabilities: {"elicitation": {"form": {}}}` e HTTP 400, mas `{"elicitation": {}}` vale como suporte a form mode, por retrocompatibilidade da spec ("an empty elicitation capability object defaults to form mode support"). Mantivemos o comportamento do SDK, coberto por teste (`test/servidor-mcp-mrtr.test.ts`, "elicitation vazio vale como form mode"). O agente sempre declara a forma explicita `{"elicitation": {"form": {}}}`.
- Validacao do Pedido no modulo de dominio `servidor-mcp/src/agenda.ts` (sem MCP), nesta ordem: Sala inexistente, data invalida (`Data invalida: <valor>`, sem offset ou ilegivel), Intervalo invertido ou vazio, Janela de uso, duracao, disponibilidade. Qualquer offset e aceito; as comparacoes usam o instante e as saidas sao normalizadas em `-03:00`.

### Agente: host MCP

- `@modelcontextprotocol/client` 2.4.0, uma unica instancia de `Client` viva o processo todo, fixada no protocolo `2026-07-28`, com capabilities `{"elicitation": {"form": {}}}`. A conexao usa `prior` com a descoberta conhecida, entao nao toca a rede: o agente sobe com o servidor MCP fora do ar e sobrevive a reinicios dele. Nenhuma sessao: o SDK manda o envelope de `_meta` e os headers `MCP-Protocol-Version`, `Mcp-Method` e `Mcp-Name` em todo request.
- A cada Task nova: `tools/list` (falha se `reservar_sala` nao estiver la), `resources/read politica://uso` (versao da primeira linha, que vai no campo `politica` do artifact) e `tools/call reservar_sala`.
- Limitacao do SDK contornada sem reescrever protocolo: `client.callTool()` lanca `SdkError` `UNSUPPORTED_RESULT_TYPE` quando a tool responde `input_required`, mesmo com `autoFulfill: false` (ele nao tem o caminho `allowInputRequired`). Por isso toda chamada usa `client.request(..., { allowInputRequired: true })`, como a spec descreve.
- `traceparent`: o trace-id do header `traceparent` do primeiro `SendMessage` fica preso a Task e vai em `_meta.traceparent` de todo request MCP dela, com span-id novo. Header ausente ou invalido: o agente gera um trace-id.
- `isError` da tool: Task em `TASK_STATE_FAILED` com o texto exato da tool. Erro de JSON-RPC ou servidor MCP fora do ar: `TASK_STATE_FAILED` com a mensagem do erro (`Servidor MCP indisponivel: ...`).

### Agente: lado A2A escrito a mao

O lado A2A nao usa `@a2a-js/sdk`; e JSON-RPC 2.0 sobre `node:http` em `agente/src/entrada.ts`. O motivo esta em [docs/adr/0001-a2a-sem-sdk.md](docs/adr/0001-a2a-sem-sdk.md): o SDK trata request sem header `A2A-Version` como 0.3 e o recusa com `-32009`, e o validador nao envia esse header. As formas de wire (card, Task, Message, Part, Artifact, `TASK_STATE_*`, `ROLE_*`) sao copiadas de `exemplos/wire/`. Erros: `-32001` Task desconhecida, `-32004` mensagem a Task terminal (ou que nao esta em Pausa), `-32009` `A2A-Version` explicito diferente de `1.0` (header ausente vale como `1.0`), `-32602` params malformados, `-32601` metodo fora de `SendMessage`/`GetTask`.

### Desvios em relacao a spec, registrados

- **A Recusa passa por `WORKING` antes de `CANCELED`.** A spec descreve `INPUT_REQUIRED -> CANCELED` depois do retry com `decline`. Aqui a Recusa faz como a Escolha: a Task vai para `TASK_STATE_WORKING` durante o retry com `decline` e so entao para `TASK_STATE_CANCELED` (a tabela permite `WORKING -> CANCELED`; ver o comentario em `agente/src/task.ts`). Assim a Task nunca aceita duas continuacoes ao mesmo tempo, e uma falha do servidor MCP no retry ainda termina em `FAILED`. Quem so ve as respostas do `SendMessage` enxerga `INPUT_REQUIRED` e depois `CANCELED`.
- **`{"elicitation": {}}` conta como form mode** (comportamento do SDK, descrito acima).
- **Pre-checagem de `_meta` no wrapper** em vez do `-32022` do SDK (descrito acima).
- **A2A sem SDK** ([ADR 0001](docs/adr/0001-a2a-sem-sdk.md)).
- Os dois processos escutam so em `127.0.0.1`. `http://localhost:...` funciona (o validador e o `curl` caem no IPv4).

### Dependencias

So `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/client` 2.4.0, `@modelcontextprotocol/node` 2.1.2 e `zod` 4.6.7 em runtime; `tsx`, `typescript` e `@types/node` em desenvolvimento. Nenhum SDK de A2A, nenhum SDK de LLM. O agente decide por regra: o mesmo pedido produz sempre o mesmo resultado.

## Saida do validador

Ultima execucao: clone limpo da branch, `npm ci`, os dois processos subidos com `npm run mcp` e `npm run agente` (portas padrao, recem-iniciados) e o comando da secao "Como rodar":

```
SAIDA_DO_VALIDADOR
```
