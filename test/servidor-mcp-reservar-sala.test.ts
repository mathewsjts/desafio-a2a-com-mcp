// Ponto A: reservar_sala no caminho feliz e nos erros de dominio, so por HTTP.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorMcp, mcp, textoDe, type Processo } from './harness.ts';

describe('servidor MCP: reservar_sala', () => {
  let srv: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    url = `${srv.url}/mcp`;
  });
  after(async () => { await srv.parar(); });

  const reservar = (args: { sala: string; inicio: string; fim: string; responsavel: string }) =>
    mcp(url, 'tools/call', { name: 'reservar_sala', arguments: args });
  const consultar = (args: { sala: string; inicio: string; fim: string }) =>
    mcp(url, 'tools/call', { name: 'consultar_disponibilidade', arguments: args });

  test('Sala livre: devolve a Reserva completa e ela passa a conflitar na consulta seguinte', async () => {
    const r = await reservar({ sala: 'sala-aquario', inicio: '2026-11-03T12:00:00Z', fim: '2026-11-03T13:00:00Z', responsavel: 'Doc' });
    assert.equal(r.status, 200);
    const resultado = r.corpo?.result;
    assert.ok(!resultado.isError, textoDe(resultado));
    assert.deepEqual(resultado.structuredContent, {
      reserva: 'res-0003',
      reservado: true,
      sala: 'sala-aquario',
      inicio: '2026-11-03T09:00:00-03:00',
      fim: '2026-11-03T10:00:00-03:00',
      responsavel: 'Doc',
      politica: '2026-11-01',
      motivo: null,
    });
    assert.deepEqual(JSON.parse(textoDe(resultado)), resultado.structuredContent);

    const consulta = await consultar({ sala: 'sala-aquario', inicio: '2026-11-03T09:30:00-03:00', fim: '2026-11-03T10:30:00-03:00' });
    assert.deepEqual(consulta.corpo?.result?.structuredContent, {
      sala: 'sala-aquario',
      livre: false,
      conflitos: [{ id: 'res-0003', inicio: '2026-11-03T09:00:00-03:00', fim: '2026-11-03T10:00:00-03:00', responsavel: 'Doc' }],
    });
  });

  for (const [caso, args, mensagem] of [
    ['Sala inexistente', { sala: 'sala-delorean', inicio: '2026-11-04T09:00:00-03:00', fim: '2026-11-04T10:00:00-03:00' }, 'Sala inexistente: sala-delorean'],
    ['data sem offset', { sala: 'sala-aquario', inicio: '2026-11-04T09:00:00', fim: '2026-11-04T10:00:00-03:00' }, 'Data invalida: 2026-11-04T09:00:00'],
    ['Intervalo invertido', { sala: 'sala-aquario', inicio: '2026-11-04T10:00:00-03:00', fim: '2026-11-04T09:00:00-03:00' }, 'Intervalo invalido: fim deve ser posterior a inicio'],
    ['fora da Janela de uso', { sala: 'sala-aquario', inicio: '2026-11-04T07:00:00-03:00', fim: '2026-11-04T08:00:00-03:00' }, 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00'],
    ['duracao acima de 2h', { sala: 'sala-aquario', inicio: '2026-11-04T09:00:00-03:00', fim: '2026-11-04T12:00:00-03:00' }, 'Duracao acima do limite: a politica permite no maximo 2 horas'],
  ] as const) {
    test(`erro de dominio volta como isError com a mensagem exata: ${caso}`, async () => {
      const r = await reservar({ ...args, responsavel: 'Doc' });
      assert.equal(r.status, 200);
      assert.equal(r.corpo?.result?.isError, true);
      assert.equal(textoDe(r.corpo?.result), mensagem);
    });
  }
});
