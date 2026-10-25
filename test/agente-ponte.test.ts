// Ponto A: a ponte. Um Conflito vira Pausa da Task A2A, e a Escolha (ou a
// Recusa) repete o tools/call com o requestState ecoado. O agente fala com o
// servidor MCP real atraves de um espiao HTTP, que mostra o que o agente mandou
// sem olhar dentro dele. Um processo de cada por describe: cada teste usa um dia
// proprio, porque as Reservas valem ate o fim do processo.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enviarMensagem,
  iniciarAgente,
  iniciarEspiaoMcp,
  iniciarServidorMcp,
  mcp,
  obterTask,
  taskDe,
  type EspiaoMcp,
  type Processo,
} from './harness.ts';

const em = (dia: string, hora: string) => `2026-11-${dia}T${hora}:00-03:00`;
const pedido = (sala: string, dia: string, de: string, ate: string, responsavel = 'Marty') =>
  `reservar sala=${sala} inicio=${em(dia, de)} fim=${em(dia, ate)} responsavel=${responsavel}`;

/** Garagem no dia 3, das 14 as 15: ocupada por res-0001 nos dados do starter. */
const PEDIDO_EM_CONFLITO = pedido('sala-garagem', '03', '14:00', '15:00');

describe('agente: a ponte (Pausa e continuacao)', () => {
  let srv: Processo;
  let espiao: EspiaoMcp;
  let agente: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    espiao = await iniciarEspiaoMcp(srv.url);
    agente = await iniciarAgente({ mcpUrl: `${espiao.url}/mcp` });
    url = `${agente.url}/a2a`;
  });
  after(async () => {
    await agente.parar();
    await espiao.parar();
    await srv.parar();
  });

  /** Reserva a Sala direto no servidor MCP (sem passar pelo agente nem pelo espiao). */
  async function ocupar(sala: string, dia: string, de: string, ate: string) {
    const r = await mcp(`${srv.url}/mcp`, 'tools/call', {
      name: 'reservar_sala',
      arguments: { sala, inicio: em(dia, de), fim: em(dia, ate), responsavel: 'Ocupante' },
    });
    assert.equal(r.corpo?.result?.structuredContent?.reservado, true, JSON.stringify(r.corpo));
  }

  /** Abre uma Task com o Pedido e confere que ela parou na Pausa. */
  async function pausar(texto: string, op: { traceparent?: string } = {}) {
    const task = taskDe(await enviarMensagem(url, texto, op));
    assert.equal(task?.status?.state, 'TASK_STATE_INPUT_REQUIRED', JSON.stringify(task));
    return task;
  }

  test('um Pedido em Conflito pausa a Task com exatamente a linha de Alternativas, na ordem do servidor', async () => {
    const r = await enviarMensagem(url, PEDIDO_EM_CONFLITO, { messageId: 'msg-conflito-1' });
    const task = taskDe(r);
    assert.equal(task?.status?.state, 'TASK_STATE_INPUT_REQUIRED', JSON.stringify(r.corpo));

    const status = task.status.message;
    assert.equal(status.role, 'ROLE_AGENT');
    assert.deepEqual(status.parts, [{ text: 'alternativas: sala-fusca, sala-mirante' }]);
    assert.equal(status.taskId, task.id);
    assert.equal(status.contextId, task.contextId);
    assert.deepEqual(task.history, [
      { messageId: 'msg-conflito-1', role: 'ROLE_USER', parts: [{ text: PEDIDO_EM_CONFLITO }] },
      status,
    ]);
    assert.deepEqual(task.artifacts, []);

    assert.deepEqual(taskDe(await obterTask(url, task.id)), task);
  });

  test('escolha=<id> repete o tools/call com id novo, os argumentos originais, inputResponses accept e o requestState ecoado, e conclui na Sala escolhida', async () => {
    await ocupar('sala-garagem', '04', '10:00', '11:00');
    const antes = espiao.trocas().length;
    const pausada = await pausar(pedido('sala-garagem', '04', '10:00', '11:00'));

    const r = await enviarMensagem(url, 'escolha=sala-mirante', { taskId: pausada.id, messageId: 'msg-escolha-1' });
    const task = taskDe(r);
    assert.equal(task?.status?.state, 'TASK_STATE_COMPLETED', JSON.stringify(r.corpo));
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.artifacts[0].name, 'reserva');
    const { reserva, ...resto } = JSON.parse(task.artifacts[0].parts[0].text);
    assert.match(reserva, /^res-\d{4}$/);
    assert.deepEqual(resto, { sala: 'sala-mirante', inicio: em('04', '10:00'), fim: em('04', '11:00'), responsavel: 'Marty', politica: '2026-11-01' });
    assert.deepEqual(task.status.message.parts, [{ text: `Reserva ${reserva} confirmada na sala-mirante.` }]);
    assert.deepEqual(task.history, [
      ...pausada.history,
      { messageId: 'msg-escolha-1', role: 'ROLE_USER', parts: [{ text: 'escolha=sala-mirante' }], taskId: pausada.id },
      task.status.message,
    ]);

    const chamadas = espiao.trocas().slice(antes).filter((t) => t.pedido?.method === 'tools/call');
    assert.equal(chamadas.length, 2, 'o tools/call original e o retry');
    const [original, retry] = chamadas;
    assert.equal(original.resposta?.result?.resultType, 'input_required');
    assert.notEqual(retry.pedido.id, original.pedido.id);
    assert.deepEqual(retry.pedido.params.arguments, original.pedido.params.arguments);
    assert.deepEqual(retry.pedido.params.inputResponses, { escolha_de_sala: { action: 'accept', content: { sala: 'sala-mirante' } } });
    assert.equal(retry.pedido.params.requestState, original.resposta.result.requestState);
    assert.ok(retry.bruto.includes(JSON.stringify(original.resposta.result.requestState)), 'requestState ecoado byte a byte');
  });

  test('escolha=recusar repete o tools/call com decline e cancela a Task sem Reserva', async () => {
    await ocupar('sala-garagem', '05', '10:00', '11:00');
    const antes = espiao.trocas().length;
    const pausada = await pausar(pedido('sala-garagem', '05', '10:00', '11:00'));

    const task = taskDe(await enviarMensagem(url, 'escolha=recusar', { taskId: pausada.id }));
    assert.equal(task?.status?.state, 'TASK_STATE_CANCELED', JSON.stringify(task));
    assert.equal(task.status.message.role, 'ROLE_AGENT');
    assert.ok(task.status.message.parts[0].text.length > 0);
    assert.deepEqual(task.artifacts, []);
    assert.equal(task.history.length, 4);

    const [original, retry] = espiao.trocas().slice(antes).filter((t) => t.pedido?.method === 'tools/call');
    assert.deepEqual(retry.pedido.params.inputResponses, { escolha_de_sala: { action: 'decline' } });
    assert.equal(retry.pedido.params.requestState, original.resposta.result.requestState);
    assert.equal(retry.resposta?.result?.structuredContent?.reservado, false);

    // A mensagem de cancelamento e fixa.
    await ocupar('sala-garagem', '05', '12:00', '13:00');
    const outra = await pausar(pedido('sala-garagem', '05', '12:00', '13:00'));
    const cancelada = taskDe(await enviarMensagem(url, 'escolha=recusar', { taskId: outra.id }));
    assert.deepEqual(cancelada.status.message.parts, task.status.message.parts);
  });
});
