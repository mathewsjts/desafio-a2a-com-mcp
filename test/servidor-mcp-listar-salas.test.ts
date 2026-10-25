// Ponto A: descoberta de tools e listar_salas.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorMcp, mcp, textoDe, type Processo } from './harness.ts';

// As cinco Salas do starter (dados/salas.json), copiadas como fonte de verdade independente.
const SALAS_DO_STARTER = [
  { id: 'sala-aquario', nome: 'Aquario', capacidade: 4, recursos: ['tv'] },
  { id: 'sala-porao', nome: 'Porao', capacidade: 6, recursos: ['quadro'] },
  { id: 'sala-garagem', nome: 'Garagem', capacidade: 12, recursos: ['tv', 'quadro'] },
  { id: 'sala-fusca', nome: 'Fusca', capacidade: 12, recursos: ['tv'] },
  { id: 'sala-mirante', nome: 'Mirante', capacidade: 20, recursos: ['tv', 'quadro', 'camera'] },
];

describe('servidor MCP: tools/list e listar_salas', () => {
  let srv: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    url = `${srv.url}/mcp`;
  });
  after(async () => { await srv.parar(); });

  test('tools/list traz listar_salas sem parametros e com outputSchema', async () => {
    const r = await mcp(url, 'tools/list');
    assert.equal(r.status, 200);
    const tools = r.corpo?.result?.tools as any[];
    const listar = tools.find((t) => t.name === 'listar_salas');
    assert.ok(listar, `tools: ${tools.map((t) => t.name)}`);
    assert.equal(listar.inputSchema.type, 'object');
    assert.deepEqual(listar.inputSchema.properties ?? {}, {});
    assert.equal(listar.outputSchema.type, 'object');
    assert.ok(listar.outputSchema.properties.salas, 'outputSchema declara salas');
  });

  test('tools/list traz as tres tools, cada uma com inputSchema de objeto e outputSchema', async () => {
    const r = await mcp(url, 'tools/list');
    const tools = r.corpo?.result?.tools as any[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ['consultar_disponibilidade', 'listar_salas', 'reservar_sala']);
    for (const t of tools) {
      assert.equal(t.inputSchema?.type, 'object', t.name);
      assert.equal(t.outputSchema?.type, 'object', t.name);
    }
  });

  test('listar_salas devolve as Salas do starter em structuredContent e o mesmo JSON em texto', async () => {
    const r = await mcp(url, 'tools/call', { name: 'listar_salas', arguments: {} });
    assert.equal(r.status, 200);
    const resultado = r.corpo?.result;
    assert.ok(!resultado.isError, textoDe(resultado));
    assert.deepEqual(resultado.structuredContent, { salas: SALAS_DO_STARTER });
    assert.deepEqual(JSON.parse(textoDe(resultado)), resultado.structuredContent);
  });
});
