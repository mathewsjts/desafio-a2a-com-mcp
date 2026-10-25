// Ponto A: o agente conduz uma Task de Sala livre ate COMPLETED, falando com o
// servidor MCP real so por HTTP. Um par de processos novos por describe: a
// primeira Reserva do processo e res-0003.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  a2a,
  enviarMensagem,
  iniciarAgente,
  iniciarServidorMcp,
  obterTask,
  taskDe,
  textoDaMensagem,
  type Processo,
} from './harness.ts';

const PEDIDO_LIVRE = 'reservar sala=sala-porao inicio=2026-11-03T09:00:00-03:00 fim=2026-11-03T10:00:00-03:00 responsavel=Doc';

describe('agente: Task de Sala livre', () => {
  let srv: Processo;
  let agente: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    agente = await iniciarAgente({ mcpUrl: `${srv.url}/mcp` });
    url = `${agente.url}/a2a`;
  });
  after(async () => {
    await agente.parar();
    await srv.parar();
  });

  let concluida: any;

  test('SendMessage sem taskId abre uma Task que conclui com a mensagem de confirmacao e o artifact reserva', async () => {
    const r = await enviarMensagem(url, PEDIDO_LIVRE, { id: 'pedido-1', messageId: 'msg-pedido-1' });
    assert.equal(r.status, 200);
    assert.equal(r.corpo?.jsonrpc, '2.0');
    assert.equal(r.corpo?.id, 'pedido-1');

    const task = taskDe(r);
    assert.match(task.id, /^task-[0-9a-f]+$/);
    assert.match(task.contextId, /^ctx-[0-9a-f]+$/);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');

    const status = task.status.message;
    assert.match(status.messageId, /^msg-[0-9a-f]+$/);
    assert.equal(status.role, 'ROLE_AGENT');
    assert.deepEqual(status.parts, [{ text: 'Reserva res-0003 confirmada na sala-porao.' }]);
    assert.equal(status.taskId, task.id);
    assert.equal(status.contextId, task.contextId);

    assert.deepEqual(task.history, [
      { messageId: 'msg-pedido-1', role: 'ROLE_USER', parts: [{ text: PEDIDO_LIVRE }] },
      status,
    ]);

    assert.equal(task.artifacts.length, 1);
    const [artifact] = task.artifacts;
    assert.match(artifact.artifactId, /^art-[0-9a-f]+$/);
    assert.equal(artifact.name, 'reserva');
    assert.equal(artifact.parts.length, 1);
    assert.deepEqual(JSON.parse(artifact.parts[0].text), {
      reserva: 'res-0003',
      sala: 'sala-porao',
      inicio: '2026-11-03T09:00:00-03:00',
      fim: '2026-11-03T10:00:00-03:00',
      responsavel: 'Doc',
      politica: '2026-11-01',
    });
    concluida = task;
  });

  test('GetTask devolve a mesma Task: id, contextId, estado, historico e artifacts', async () => {
    assert.ok(concluida, 'depende do teste anterior');
    const r = await obterTask(url, concluida.id, { id: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.corpo?.id, 7);
    assert.deepEqual(taskDe(r), concluida);
  });

  test('cada Pedido abre uma Task nova, com id e contextId proprios', async () => {
    const r = await enviarMensagem(url, 'reservar sala=sala-porao inicio=2026-11-04T09:00:00-03:00 fim=2026-11-04T10:00:00-03:00 responsavel=Doc');
    const task = taskDe(r);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.notEqual(task.id, concluida.id);
    assert.notEqual(task.contextId, concluida.contextId);
  });

  test('o Responsavel e o resto da linha: aceita espacos e perde so os das pontas', async () => {
    const r = await enviarMensagem(url, 'reservar sala=sala-fusca inicio=2026-11-05T09:00:00-03:00 fim=2026-11-05T10:00:00-03:00 responsavel=  Emmett Brown  ');
    const task = taskDe(r);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED', textoDaMensagem(task.status.message));
    assert.equal(JSON.parse(task.artifacts[0].parts[0].text).responsavel, 'Emmett Brown');
  });

  test('metodo desconhecido recebe -32601', async () => {
    const r = await a2a(url, 'CancelTask', { id: concluida.id }, { id: 'x' });
    assert.equal(r.corpo?.jsonrpc, '2.0');
    assert.equal(r.corpo?.id, 'x');
    assert.equal(r.corpo?.error?.code, -32601);
    assert.equal(r.corpo?.result, undefined);
  });
});
