// Ponto A: o trace-id da Task chega a todos os requests MCP, conferido no
// stderr do servidor MCP. A ordem do log mostra a descoberta antes da chamada.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enviarMensagem,
  iniciarAgente,
  iniciarServidorMcp,
  novoTraceparent,
  taskDe,
  traceIdDe,
  type Processo,
} from './harness.ts';

const pedido = (dia: string) =>
  `reservar sala=sala-aquario inicio=2026-11-${dia}T09:00:00-03:00 fim=2026-11-${dia}T10:00:00-03:00 responsavel=Doc`;

const spanIdDe = (traceparent: unknown) => String(traceparent).split('-')[2];

describe('agente: propagacao do traceparent para o MCP', () => {
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

  /** Linhas de log do MCP com o trace-id dado, na ordem em que chegaram. */
  const linhasDoTrace = (traceId: string) => srv.logs().filter((l) => traceIdDe(l.traceparent) === traceId);

  /** Espera `n` linhas de tools/call depois das `antes` primeiras e devolve as linhas novas. */
  async function linhasNovas(antes: number, n: number) {
    const chamadas = () => srv.logs().slice(antes).filter((l) => l.method === 'tools/call').length;
    await srv.esperarLog(() => chamadas() >= n);
    return srv.logs().slice(antes);
  }

  test('com traceparent no header: tools/list, resources/read e tools/call levam o mesmo trace-id, cada um com span-id novo', async () => {
    const traceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const enviado = novoTraceparent(traceId);
    const r = await enviarMensagem(url, pedido('10'), { traceparent: enviado });
    assert.equal(taskDe(r)?.status?.state, 'TASK_STATE_COMPLETED');

    await srv.esperarLog((l) => l.method === 'tools/call' && traceIdDe(l.traceparent) === traceId);
    const linhas = linhasDoTrace(traceId);
    assert.deepEqual(linhas.map((l) => l.method), ['tools/list', 'resources/read', 'tools/call']);

    const spans = linhas.map((l) => spanIdDe(l.traceparent));
    assert.equal(new Set([...spans, spanIdDe(enviado)]).size, 4, `span-ids repetidos: ${spans.join(', ')}`);
    assert.equal(new Set(linhas.map((l) => l.id)).size, 3, 'cada request MCP tem id proprio');
  });

  test('sem traceparent: a Task ganha um trace-id gerado, o mesmo em todos os requests MCP dela', async () => {
    const antes = srv.logs().length;
    const r = await enviarMensagem(url, pedido('11'));
    assert.equal(taskDe(r)?.status?.state, 'TASK_STATE_COMPLETED');

    const novas = await linhasNovas(antes, 1);
    assert.deepEqual(novas.map((l) => l.method), ['tools/list', 'resources/read', 'tools/call']);
    const traceIds = novas.map((l) => traceIdDe(l.traceparent));
    assert.ok(traceIds[0], `traceparent invalido: ${novas[0].traceparent}`);
    assert.notEqual(traceIds[0], '0'.repeat(32));
    assert.deepEqual(traceIds, [traceIds[0], traceIds[0], traceIds[0]]);
  });

  for (const [caso, header] of [
    ['malformado', 'nao-e-um-traceparent'],
    ['com trace-id zerado', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
  ] as const) {
    test(`traceparent ${caso}: a Task ganha um trace-id gerado`, async () => {
      const antes = srv.logs().length;
      const r = await enviarMensagem(url, pedido(caso === 'malformado' ? '16' : '17'), { traceparent: header });
      assert.equal(taskDe(r)?.status?.state, 'TASK_STATE_COMPLETED');
      const novas = await linhasNovas(antes, 1);
      const traceIds = new Set(novas.map((l) => traceIdDe(l.traceparent)));
      assert.equal(traceIds.size, 1);
      const [traceId] = traceIds;
      assert.ok(traceId && traceId !== '0'.repeat(32), `trace-id gerado invalido: ${novas[0].traceparent}`);
    });
  }

  test('duas Tasks sem traceparent ganham trace-ids diferentes', async () => {
    const antes = srv.logs().length;
    await enviarMensagem(url, pedido('12'));
    await enviarMensagem(url, pedido('13'));
    const chamadas = (await linhasNovas(antes, 2)).filter((l) => l.method === 'tools/call');
    assert.equal(chamadas.length, 2);
    assert.notEqual(traceIdDe(chamadas[0].traceparent), traceIdDe(chamadas[1].traceparent));
  });

  test('o agente nao faz nenhum request MCP sem traceparent (nem na conexao)', () => {
    assert.ok(srv.logs().length > 0);
    assert.deepEqual(srv.logs().filter((l) => !traceIdDe(l.traceparent)), []);
  });
});
