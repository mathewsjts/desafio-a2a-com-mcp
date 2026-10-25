// Ponto A: falhas e estados terminais do agente, vistos so pelo HTTP. Versao
// A2A, Pedido invalido, erro de dominio do MCP, MCP fora do ar, `taskId`
// desconhecido e Task terminal.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  a2a,
  enviarMensagem,
  iniciarAgente,
  iniciarServidorMcp,
  novoTraceparent,
  obterTask,
  taskDe,
  textoDaMensagem,
  traceIdDe,
  type Processo,
} from './harness.ts';

/** Pedido para a sala-porao, livre no dia dado (cada teste usa um dia proprio). */
const pedidoLivre = (dia: string) =>
  `reservar sala=sala-porao inicio=2026-11-${dia}T09:00:00-03:00 fim=2026-11-${dia}T10:00:00-03:00 responsavel=Doc`;

describe('agente: header A2A-Version', () => {
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

  test('A2A-Version explicito diferente de 1.0 recebe -32009, com HTTP 200 e o id do request', async () => {
    const r = await enviarMensagem(url, pedidoLivre('04'), { id: 'versao-1', headers: { 'A2A-Version': '0.3' } });
    assert.equal(r.status, 200);
    assert.equal(r.corpo?.id, 'versao-1');
    assert.equal(r.corpo?.error?.code, -32009);
    assert.equal(r.corpo?.result, undefined);
  });

  test('A2A-Version diferente de 1.0 tambem e recusado em GetTask', async () => {
    const r = await a2a(url, 'GetTask', { id: 'task-000000000000' }, { headers: { 'A2A-Version': '2.0' } });
    assert.equal(r.corpo?.error?.code, -32009);
  });

  test('A2A-Version 1.0 explicito e aceito', async () => {
    const r = await enviarMensagem(url, pedidoLivre('05'), { headers: { 'A2A-Version': '1.0' } });
    assert.equal(r.corpo?.error, undefined);
    assert.equal(taskDe(r)?.status?.state, 'TASK_STATE_COMPLETED');
  });
});

describe('agente: Pedido invalido e erro de dominio do MCP', () => {
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

  test('Pedido fora da forma fixa termina em FAILED com o formato esperado, sem chamar o MCP', async () => {
    const traceInvalido = 'b1b2c3d4e5f60718293a4b5c6d7e8f90';
    const r = await enviarMensagem(url, 'quero a sala-porao amanha cedo', {
      messageId: 'msg-invalido',
      traceparent: novoTraceparent(traceInvalido),
    });
    assert.equal(r.corpo?.error, undefined);
    const task = taskDe(r);
    assert.equal(task.status.state, 'TASK_STATE_FAILED');
    assert.equal(
      textoDaMensagem(task.status.message),
      'Pedido invalido: use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>',
    );
    assert.deepEqual(task.history, [
      { messageId: 'msg-invalido', role: 'ROLE_USER', parts: [{ text: 'quero a sala-porao amanha cedo' }] },
      task.status.message,
    ]);
    assert.deepEqual(task.artifacts, []);

    // O SendMessage e sincrono: depois de um Pedido valido chegar ao MCP, o
    // invalido (anterior) ja teria aparecido no log se tivesse chamado o MCP.
    const traceValido = 'c1b2c3d4e5f60718293a4b5c6d7e8f90';
    await enviarMensagem(url, pedidoLivre('06'), { traceparent: novoTraceparent(traceValido) });
    await srv.esperarLog((l) => l.method === 'tools/call' && traceIdDe(l.traceparent) === traceValido);
    assert.deepEqual(srv.logs().filter((l) => traceIdDe(l.traceparent) === traceInvalido), []);
  });

  test('erro de dominio do MCP (isError) termina em FAILED com o texto da tool, sem alteracao', async () => {
    const pedido = 'reservar sala=sala-delorean inicio=2026-11-04T09:00:00-03:00 fim=2026-11-04T10:00:00-03:00 responsavel=Doc';
    const r = await enviarMensagem(url, pedido);
    assert.equal(r.corpo?.error, undefined);
    const task = taskDe(r);
    assert.equal(task.status.state, 'TASK_STATE_FAILED');
    assert.deepEqual(task.status.message.parts, [{ text: 'Sala inexistente: sala-delorean' }]);
    assert.deepEqual(task.history.at(-1), task.status.message);
    assert.deepEqual(task.artifacts, []);
  });
});

describe('agente: taskId desconhecido e Task terminal', () => {
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

  test('SendMessage com taskId desconhecido recebe -32001', async () => {
    const r = await enviarMensagem(url, 'escolha=sala-aquario', { id: 'desconhecida-1', taskId: 'task-ffffffffffff' });
    assert.equal(r.status, 200);
    assert.equal(r.corpo?.id, 'desconhecida-1');
    assert.equal(r.corpo?.error?.code, -32001);
    assert.equal(r.corpo?.result, undefined);
  });

  test('GetTask com id desconhecido recebe -32001', async () => {
    const r = await obterTask(url, 'task-ffffffffffff', { id: 'desconhecida-2' });
    assert.equal(r.status, 200);
    assert.equal(r.corpo?.id, 'desconhecida-2');
    assert.equal(r.corpo?.error?.code, -32001);
  });

  /** SendMessage a uma Task terminal: -32004, e o GetTask devolve a mesma Task de antes. */
  async function recusaTerminal(taskId: string, texto: string) {
    const antes = taskDe(await obterTask(url, taskId));
    const r = await enviarMensagem(url, texto, { id: `terminal-${taskId}`, taskId });
    assert.equal(r.status, 200);
    assert.equal(r.corpo?.id, `terminal-${taskId}`);
    assert.equal(r.corpo?.error?.code, -32004);
    assert.equal(r.corpo?.result, undefined);
    assert.deepEqual(taskDe(await obterTask(url, taskId)), antes);
  }

  test('SendMessage a uma Task COMPLETED recebe -32004 e a Task nao muda', async () => {
    const task = taskDe(await enviarMensagem(url, pedidoLivre('07')));
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    await recusaTerminal(task.id, pedidoLivre('08'));
    // Nem o Pedido valido reenviado na Task terminal chega a reservar: o slot continua livre.
    assert.equal(taskDe(await enviarMensagem(url, pedidoLivre('08'))).status.state, 'TASK_STATE_COMPLETED');
  });

  test('SendMessage a uma Task FAILED recebe -32004 e a Task nao muda', async () => {
    const task = taskDe(await enviarMensagem(url, 'nao e um pedido'));
    assert.equal(task.status.state, 'TASK_STATE_FAILED');
    await recusaTerminal(task.id, pedidoLivre('09'));
  });

  test('SendMessage a uma Task CANCELED recebe -32004 e a Task nao muda', async () => {
    // Garagem no dia 3, das 14 as 15: ocupada por res-0001 nos dados do starter.
    const pausada = taskDe(await enviarMensagem(url, 'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Biff'));
    assert.equal(pausada.status.state, 'TASK_STATE_INPUT_REQUIRED');
    const cancelada = taskDe(await enviarMensagem(url, 'escolha=recusar', { taskId: pausada.id }));
    assert.equal(cancelada.status.state, 'TASK_STATE_CANCELED');
    await recusaTerminal(cancelada.id, 'escolha=sala-fusca');
  });
});

describe('agente: servidor MCP fora do ar', () => {
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

  test('com o servidor MCP parado, o SendMessage nao devolve erro e a Task termina em FAILED com a mensagem da falha', async () => {
    // Uma Task completa antes, para o agente ja ter conexao aberta com o MCP.
    assert.equal(taskDe(await enviarMensagem(url, pedidoLivre('10'))).status.state, 'TASK_STATE_COMPLETED');
    await srv.parar();

    const r = await enviarMensagem(url, pedidoLivre('11'), { id: 'mcp-parado' });
    assert.equal(r.status, 200);
    assert.equal(r.corpo?.id, 'mcp-parado');
    assert.equal(r.corpo?.error, undefined);
    const task = taskDe(r);
    assert.equal(task.status.state, 'TASK_STATE_FAILED');
    assert.equal(task.status.message.role, 'ROLE_AGENT');
    assert.match(textoDaMensagem(task.status.message), /^Servidor MCP indisponivel: /);
    assert.deepEqual(task.history.at(-1), task.status.message);
    assert.deepEqual(task.artifacts, []);

    // O agente segue de pe: a Task falha fica consultavel.
    assert.deepEqual(taskDe(await obterTask(url, task.id)), task);
  });
});
