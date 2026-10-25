// Ponto A: consultar_disponibilidade (inclusive as bordas da Janela de uso) e tool inexistente, so por HTTP.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorMcp, mcp, textoDe, type Processo } from './harness.ts';

describe('servidor MCP: consultar_disponibilidade', () => {
  let srv: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    url = `${srv.url}/mcp`;
  });
  after(async () => { await srv.parar(); });

  const consultar = (args: { sala: string; inicio: string; fim: string }) =>
    mcp(url, 'tools/call', { name: 'consultar_disponibilidade', arguments: args });

  test('Intervalo livre: livre true, sem conflitos, em structuredContent e em texto', async () => {
    const r = await consultar({ sala: 'sala-aquario', inicio: '2026-11-03T09:00:00-03:00', fim: '2026-11-03T10:00:00-03:00' });
    assert.equal(r.status, 200);
    const resultado = r.corpo?.result;
    assert.ok(!resultado.isError, textoDe(resultado));
    assert.deepEqual(resultado.structuredContent, { sala: 'sala-aquario', livre: true, conflitos: [] });
    assert.deepEqual(JSON.parse(textoDe(resultado)), resultado.structuredContent);
  });

  test('Conflito com a Reserva do starter, pedido em UTC, devolve a Reserva normalizada', async () => {
    const r = await consultar({ sala: 'sala-garagem', inicio: '2026-11-03T17:30:00Z', fim: '2026-11-03T18:30:00Z' });
    const resultado = r.corpo?.result;
    assert.ok(!resultado.isError, textoDe(resultado));
    assert.deepEqual(resultado.structuredContent, {
      sala: 'sala-garagem',
      livre: false,
      conflitos: [{ id: 'res-0001', inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00', responsavel: 'Marty' }],
    });
    assert.deepEqual(JSON.parse(textoDe(resultado)), resultado.structuredContent);
  });

  test('Intervalo semiaberto: logo depois da Reserva existente esta livre', async () => {
    const r = await consultar({ sala: 'sala-garagem', inicio: '2026-11-03T15:00:00-03:00', fim: '2026-11-03T16:00:00-03:00' });
    assert.equal(r.corpo?.result?.structuredContent?.livre, true);
  });

  for (const [caso, inicio, fim] of [
    ['comeca na abertura (08:00 as 10:00)', '2026-11-05T08:00:00-03:00', '2026-11-05T10:00:00-03:00'],
    ['termina no fechamento (18:00 as 20:00)', '2026-11-05T18:00:00-03:00', '2026-11-05T20:00:00-03:00'],
    ['termina no fechamento, pedido em UTC (21:00Z as 23:00Z)', '2026-11-06T21:00:00Z', '2026-11-06T23:00:00Z'],
  ] as const) {
    test(`borda da Janela de uso e aceita: ${caso}`, async () => {
      const r = await consultar({ sala: 'sala-aquario', inicio, fim });
      const resultado = r.corpo?.result;
      assert.ok(!resultado.isError, textoDe(resultado));
      assert.equal(resultado.structuredContent?.livre, true);
    });
  }

  for (const [caso, inicio, fim] of [
    ['comeca antes da abertura (07:30 as 08:30)', '2026-11-05T07:30:00-03:00', '2026-11-05T08:30:00-03:00'],
    ['termina depois do fechamento (19:30 as 20:30)', '2026-11-05T19:30:00-03:00', '2026-11-05T20:30:00-03:00'],
    ['um minuto alem do fechamento (18:01 as 20:01)', '2026-11-05T18:01:00-03:00', '2026-11-05T20:01:00-03:00'],
  ] as const) {
    test(`Intervalo que atravessa a borda da Janela de uso e recusado: ${caso}`, async () => {
      const r = await consultar({ sala: 'sala-aquario', inicio, fim });
      assert.equal(r.corpo?.result?.isError, true);
      assert.equal(textoDe(r.corpo?.result), 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00');
    });
  }

  for (const [caso, args, mensagem] of [
    ['Sala inexistente', { sala: 'sala-delorean', inicio: '2026-11-03T09:00:00-03:00', fim: '2026-11-03T10:00:00-03:00' }, 'Sala inexistente: sala-delorean'],
    ['data sem offset', { sala: 'sala-aquario', inicio: '2026-11-03T09:00:00', fim: '2026-11-03T10:00:00-03:00' }, 'Data invalida: 2026-11-03T09:00:00'],
    ['Intervalo invertido', { sala: 'sala-aquario', inicio: '2026-11-03T10:00:00-03:00', fim: '2026-11-03T09:00:00-03:00' }, 'Intervalo invalido: fim deve ser posterior a inicio'],
    ['fora da Janela de uso', { sala: 'sala-aquario', inicio: '2026-11-03T07:00:00-03:00', fim: '2026-11-03T08:00:00-03:00' }, 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00'],
    ['duracao acima de 2h', { sala: 'sala-aquario', inicio: '2026-11-03T09:00:00-03:00', fim: '2026-11-03T12:00:00-03:00' }, 'Duracao acima do limite: a politica permite no maximo 2 horas'],
  ] as const) {
    test(`erro de dominio volta como isError com a mensagem exata: ${caso}`, async () => {
      const r = await consultar(args);
      assert.equal(r.status, 200);
      assert.equal(r.corpo?.result?.isError, true);
      assert.equal(textoDe(r.corpo?.result), mensagem);
    });
  }
});

describe('servidor MCP: tool inexistente', () => {
  let srv: Processo;
  before(async () => { srv = await iniciarServidorMcp(); });
  after(async () => { await srv.parar(); });

  test('tools/call de tool inexistente e recusado com -32602', async () => {
    const r = await mcp(`${srv.url}/mcp`, 'tools/call', { name: 'voar_delorean', arguments: {} });
    assert.equal(r.corpo?.error?.code, -32602, r.bruto);
  });
});
