// Ponto A: a Politica de uso como resource `politica://uso`.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ, iniciarServidorMcp, mcp, type Processo } from './harness.ts';

// O arquivo do starter e a fonte de verdade: o resource devolve o conteudo sem alteracao.
const POLITICA_DO_STARTER = readFileSync(join(RAIZ, 'dados', 'politica-de-uso.md'), 'utf8');

describe('servidor MCP: resource politica://uso', () => {
  let srv: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    url = `${srv.url}/mcp`;
  });
  after(async () => { await srv.parar(); });

  test('resources/read de politica://uso devolve o arquivo da Politica de uso como text/markdown', async () => {
    const r = await mcp(url, 'resources/read', { uri: 'politica://uso' });
    assert.equal(r.status, 200);
    const contents = r.corpo?.result?.contents as any[];
    assert.ok(contents, r.bruto);
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, 'politica://uso');
    assert.equal(contents[0].mimeType, 'text/markdown');
    assert.equal(contents[0].text, POLITICA_DO_STARTER);
    assert.equal(contents[0].text.split('\n')[0], 'versao: 2026-11-01');
  });

  test('resources/list lista politica://uso como text/markdown', async () => {
    const r = await mcp(url, 'resources/list');
    assert.equal(r.status, 200);
    const resources = r.corpo?.result?.resources as any[];
    assert.ok(resources, r.bruto);
    assert.deepEqual(resources.map((x) => x.uri), ['politica://uso']);
    assert.equal(resources[0].mimeType, 'text/markdown');
  });

  test('resources/read de uma URI inexistente e erro de protocolo -32602, sem contents', async () => {
    const r = await mcp(url, 'resources/read', { uri: 'politica://inexistente' });
    assert.equal(r.corpo?.error?.code, -32602, r.bruto);
    assert.equal(r.corpo?.result, undefined);
  });
});
