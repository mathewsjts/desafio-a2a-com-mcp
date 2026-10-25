// Ponto A: o requestState como entrada controlada por atacante. Estado de outra
// tool, expirado ou repetido nao vale mais do que deve; o valido sobrevive a um
// reinicio; sem segredo forte o servidor nem sobe. So por HTTP.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorMcp, mcp, type Processo } from './harness.ts';

type Args = { sala: string; inicio: string; fim: string; responsavel: string };

const em = (dia: string, hora: string) => `2026-11-${dia}T${hora}:00-03:00`;

/** Chamadas de tool contra o endpoint `/mcp` de um processo. */
function cliente(url: () => string) {
  const reservar = (args: Args) => mcp(url(), 'tools/call', { name: 'reservar_sala', arguments: args });
  const retomar = (args: Args, resposta: unknown, requestState: string, tool = 'reservar_sala') =>
    mcp(url(), 'tools/call', { name: tool, arguments: args, inputResponses: { escolha_de_sala: resposta }, requestState });
  const consultar = (sala: string, inicio: string, fim: string) =>
    mcp(url(), 'tools/call', { name: 'consultar_disponibilidade', arguments: { sala, inicio, fim } });

  /** Ocupa a Sala no Intervalo e devolve o requestState de um segundo Pedido para ela. */
  async function pausar(args: Args): Promise<string> {
    const ocupante = await reservar({ ...args, responsavel: 'Ocupante' });
    assert.equal(ocupante.corpo?.result?.structuredContent?.reservado, true, JSON.stringify(ocupante.corpo));
    const r = await reservar(args);
    assert.equal(r.corpo?.result?.resultType, 'input_required', JSON.stringify(r.corpo));
    return r.corpo.result.requestState;
  }

  return { reservar, retomar, consultar, pausar };
}

describe('servidor MCP: requestState endurecido', () => {
  let srv: Processo;
  before(async () => { srv = await iniciarServidorMcp(); });
  after(async () => { await srv.parar(); });
  const { retomar, consultar, pausar } = cliente(() => `${srv.url}/mcp`);

  for (const tool of ['listar_salas', 'consultar_disponibilidade']) {
    test(`requestState de reservar_sala apresentado a ${tool} e recusado com -32602`, async () => {
      const dia = tool === 'listar_salas' ? '05' : '06';
      const pedido = { sala: 'sala-garagem', inicio: em(dia, '10:00'), fim: em(dia, '11:00'), responsavel: 'Marty' };
      const estado = await pausar(pedido);

      const r = await retomar(pedido, { action: 'accept', content: { sala: 'sala-fusca' } }, estado, tool);
      assert.equal(r.corpo?.error?.code, -32602, JSON.stringify(r.corpo));

      const livre = await consultar('sala-fusca', pedido.inicio, pedido.fim);
      assert.equal(livre.corpo?.result?.structuredContent?.livre, true);
    });
  }

  test('replay de um requestState ja aceito nao cria uma segunda Reserva', async () => {
    const pedido = { sala: 'sala-garagem', inicio: em('10', '10:00'), fim: em('10', '11:00'), responsavel: 'Marty' };
    const estado = await pausar(pedido);
    const escolha = { action: 'accept', content: { sala: 'sala-fusca' } };

    const primeira = await retomar(pedido, escolha, estado);
    assert.equal(primeira.corpo?.result?.structuredContent?.reservado, true, JSON.stringify(primeira.corpo));
    const reserva = primeira.corpo.result.structuredContent.reserva;

    const replay = await retomar(pedido, escolha, estado);
    assert.notEqual(replay.corpo?.result?.structuredContent?.reservado, true, JSON.stringify(replay.corpo));

    const consulta = await consultar('sala-fusca', pedido.inicio, pedido.fim);
    assert.deepEqual(consulta.corpo?.result?.structuredContent?.conflitos, [
      { id: reserva, inicio: pedido.inicio, fim: pedido.fim, responsavel: 'Marty' },
    ]);
  });
});

describe('servidor MCP: requestState e reinicio', () => {
  test('retry valido depois de reiniciar o servidor conclui a Reserva', async () => {
    let srv = await iniciarServidorMcp();
    try {
      const { reservar, retomar } = cliente(() => `${srv.url}/mcp`);
      // res-0001 (dados do starter) ocupa a garagem das 14:00 as 15:00 do dia 3,
      // entao o Conflito existe de novo depois do reinicio.
      const pedido = { sala: 'sala-garagem', inicio: em('03', '14:00'), fim: em('03', '15:00'), responsavel: 'Marty' };
      const pausa = await reservar(pedido);
      assert.equal(pausa.corpo?.result?.resultType, 'input_required', JSON.stringify(pausa.corpo));

      await srv.parar();
      srv = await iniciarServidorMcp({ porta: srv.porta });

      const r = await retomar(pedido, { action: 'accept', content: { sala: 'sala-fusca' } }, pausa.corpo.result.requestState);
      const resultado = r.corpo?.result;
      assert.ok(!resultado?.isError, JSON.stringify(r.corpo));
      assert.equal(resultado.resultType, 'complete');
      assert.equal(resultado.structuredContent.reservado, true);
      assert.equal(resultado.structuredContent.sala, 'sala-fusca');
      assert.equal(resultado.structuredContent.responsavel, 'Marty');
    } finally {
      await srv.parar();
    }
  });
});

describe('servidor MCP: validade do requestState', () => {
  test('requestState expirado e recusado com -32602, sem Reserva', async () => {
    // TTL zero: o estado vence na virada do proximo segundo.
    const srv = await iniciarServidorMcp({ env: { REQUEST_STATE_TTL_SECONDS: '0' } });
    try {
      const { retomar, consultar, pausar } = cliente(() => `${srv.url}/mcp`);
      const pedido = { sala: 'sala-garagem', inicio: em('09', '10:00'), fim: em('09', '11:00'), responsavel: 'Marty' };
      const estado = await pausar(pedido);
      await new Promise((ok) => setTimeout(ok, 1100));

      const r = await retomar(pedido, { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
      assert.equal(r.corpo?.error?.code, -32602, JSON.stringify(r.corpo));

      const livre = await consultar('sala-fusca', pedido.inicio, pedido.fim);
      assert.equal(livre.corpo?.result?.structuredContent?.livre, true);
    } finally {
      await srv.parar();
    }
  });

  test('sem configuracao, o requestState vale dez minutos', async () => {
    const srv = await iniciarServidorMcp();
    try {
      const { pausar } = cliente(() => `${srv.url}/mcp`);
      const estado = await pausar({ sala: 'sala-garagem', inicio: em('09', '10:00'), fim: em('09', '11:00'), responsavel: 'Marty' });
      // O envelope e assinado, nao cifrado: `v1.<payload>.<mac>`, com `exp` em segundos.
      const { exp } = JSON.parse(Buffer.from(estado.split('.')[1], 'base64url').toString('utf8'));
      const agora = Math.floor(Date.now() / 1000);
      assert.ok(exp >= agora + 599 && exp <= agora + 600, `exp=${exp} agora=${agora}`);
    } finally {
      await srv.parar();
    }
  });
});

describe('servidor MCP: recusa subir sem configuracao segura', () => {
  for (const [caso, env, motivo] of [
    ['sem REQUEST_STATE_SECRET', { REQUEST_STATE_SECRET: undefined }, /REQUEST_STATE_SECRET ausente/],
    ['com REQUEST_STATE_SECRET vazio', { REQUEST_STATE_SECRET: '' }, /REQUEST_STATE_SECRET ausente/],
    ['com REQUEST_STATE_SECRET de 31 bytes', { REQUEST_STATE_SECRET: 'x'.repeat(31) }, /REQUEST_STATE_SECRET fraco: 31 bytes/],
    ['com REQUEST_STATE_TTL_SECONDS invalido', { REQUEST_STATE_TTL_SECONDS: 'dez' }, /REQUEST_STATE_TTL_SECONDS invalido/],
  ] as const) {
    test(`${caso}, sai com codigo diferente de zero e o motivo no stderr`, async () => {
      const srv = await iniciarServidorMcp({ env, esperarPorta: false });
      const saida = await srv.saida;
      assert.notEqual(saida.codigo, 0);
      assert.equal(saida.sinal, null);
      const stderr = srv.linhas().join('\n');
      assert.match(stderr, motivo);
      // Motivo limpo, sem stack trace.
      assert.doesNotMatch(stderr, /^\s+at /m, stderr);
    });
  }
});
