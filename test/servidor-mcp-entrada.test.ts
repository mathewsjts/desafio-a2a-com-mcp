// Ponto A: ponto de entrada HTTP do servidor MCP.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorMcp, mcp, novoTraceparent, type Processo } from './harness.ts';

describe('servidor MCP: ponto de entrada', () => {
  let srv: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    url = `${srv.url}/mcp`;
  });
  after(async () => { await srv.parar(); });

  test('request sem nenhum _meta recebe -32602 com HTTP 400 e aparece no stderr', async () => {
    const r = await mcp(url, 'tools/list', {}, { semMeta: true, id: 'sem-meta-1' });
    assert.equal(r.status, 400);
    assert.equal(r.corpo?.error?.code, -32602);
    assert.equal(r.corpo?.id, 'sem-meta-1');
    const linha = await srv.esperarLog((l) => l.id === 'sem-meta-1');
    assert.deepEqual(linha, { method: 'tools/list', id: 'sem-meta-1', traceparent: null });
  });

  for (const omitir of ['protocolVersion', 'clientCapabilities'] as const) {
    test(`_meta sem ${omitir} recebe -32602 com HTTP 400`, async () => {
      const r = await mcp(url, 'tools/call', { name: 'listar_salas', arguments: {} }, { omitir });
      assert.equal(r.status, 400);
      assert.equal(r.corpo?.error?.code, -32602);
    });
  }

  test('cada request vira uma linha JSON no stderr com method, id e o traceparent do _meta', async () => {
    const traceparent = novoTraceparent();
    const r = await mcp(url, 'tools/call', { name: 'listar_salas', arguments: {} }, { traceparent, id: 'com-trace-1' });
    assert.equal(r.status, 200);
    const linha = await srv.esperarLog((l) => l.id === 'com-trace-1');
    assert.deepEqual(linha, { method: 'tools/call', id: 'com-trace-1', traceparent });
  });

  test('toda resposta e um corpo JSON unico, nunca SSE', async () => {
    const respostas = await Promise.all([
      mcp(url, 'tools/list'),
      mcp(url, 'tools/call', { name: 'listar_salas', arguments: {} }),
      mcp(url, 'tools/list', {}, { semMeta: true }),
    ]);
    for (const r of respostas) {
      assert.match(String(r.headers['content-type']), /^application\/json/);
      assert.equal(r.corpo?.jsonrpc, '2.0', r.bruto);
    }
  });

  test('request com Host que nao e local e recusado', async () => {
    const r = await mcp(url, 'tools/list', {}, { headers: { Host: 'evil.example.com' }, id: 'host-ruim' });
    assert.equal(r.status, 403);
    assert.ok(!srv.logs().some((l) => l.id === 'host-ruim'), 'nao chega ao ponto de entrada');
  });
});
