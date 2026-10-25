# Central de Salas

Reserva de salas de reuniao da Hill Valley Tech, exposta como capacidade de agente: quem pede uma sala nao sabe nem precisa saber o que existe por tras do agente.

## Salas e reservas

**Sala**:
Espaco de reuniao identificado por um `id` fixo, com capacidade e recursos.
_Avoid_: ambiente, recurso

**Reserva**:
Ocupacao de uma Sala por um Responsavel em um Intervalo.
_Avoid_: agendamento, booking, evento

**Responsavel**:
Nome de quem fica com a Reserva.
_Avoid_: dono, usuario, solicitante

**Intervalo**:
Par `inicio`/`fim` de uma Reserva, em que `fim` e estritamente posterior a `inicio`.
_Avoid_: periodo, slot, horario

**Politica de uso**:
Conjunto versionado de regras que toda Reserva precisa respeitar. A versao identifica qual politica valia quando a Reserva foi feita.
_Avoid_: regras, termos

**Janela de uso**:
Faixa do dia, no horario de Sao Paulo, dentro da qual todo Intervalo precisa caber.
_Avoid_: expediente, horario comercial

**Conflito**:
Situacao em que o Intervalo pedido se sobrepoe ao de uma Reserva existente na mesma Sala.
_Avoid_: colisao, sala ocupada

**Alternativa**:
Sala livre no Intervalo pedido, com capacidade igual ou maior que a da Sala pedida, oferecida quando ha Conflito.
_Avoid_: sugestao, opcao

## A ponte

**Pedido**:
Solicitacao de Reserva que chega ao agente, em formato fixo, abrindo uma Task.
_Avoid_: comando, requisicao, mensagem

**Pausa**:
Estado de uma Task que espera a Escolha de quem fez o Pedido, depois de um Conflito com Alternativas.
_Avoid_: espera, bloqueio, suspensao

**Escolha**:
Resposta a uma Pausa que aceita uma das Alternativas oferecidas.
_Avoid_: selecao, opcao

**Recusa**:
Resposta a uma Pausa que nao aceita nenhuma Alternativa e encerra a Task sem Reserva.
_Avoid_: rejeicao, cancelamento (cancelamento e o estado final da Task, nao a resposta)
