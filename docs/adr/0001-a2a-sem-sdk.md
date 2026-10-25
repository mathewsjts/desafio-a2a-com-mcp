# Lado A2A do agente escrito a mao, sem `@a2a-js/sdk`

O agente atende o binding JSON-RPC do A2A v1.0 (`SendMessage`, `GetTask` e o Agent Card) com codigo proprio em `node:http`, e nao com o `@a2a-js/sdk@1.3.0`. O SDK implementa a v1.0, mas segue a regra de default da spec: request sem o header `A2A-Version` e tratado como 0.3 e recusado com `-32009`. O cliente de conformidade nao envia esse header. Usar o SDK exigiria um middleware que injeta uma versao que o cliente nao declarou. Como sao so dois metodos, escrevemos a maquina de estados da Task explicitamente, que e justamente a parte que a ponte precisa deixar visivel.

## Consequences

- As formas de wire (Task, Message, Part, Artifact, enums `TASK_STATE_*` e `ROLE_*`) sao copiadas de `exemplos/wire/` e mantidas por nos.
- Codigos de erro: `-32001` para `taskId` desconhecido, `-32004` para mensagem a Task em estado terminal e `-32009` para `A2A-Version` explicito diferente de `1.0`. A ausencia do header e aceita como `1.0`.
