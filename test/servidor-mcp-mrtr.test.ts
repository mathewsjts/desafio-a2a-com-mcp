// Ponto A: Conflito em reservar_sala com MRTR (input_required, requestState e
// retry), so por HTTP. Um processo por describe: as Reservas criadas valem ate o
// fim dele, entao cada teste usa um dia proprio.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorMcp, mcp, textoDe, type Processo } from './harness.ts';

type Args = { sala: string; inicio: string; fim: string; responsavel: string };

const MENSAGEM = 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.';
const SEM_ALTERNATIVAS = 'Sem alternativas disponiveis no intervalo';
const em = (dia: string, hora: string) => `2026-11-${dia}T${hora}:00-03:00`;

/** O input_required do contrato para estas Alternativas, sem o requestState. */
function pedidoDeEscolha(alternativas: string[]) {
  return {
    escolha_de_sala: {
      method: 'elicitation/create',
      params: {
        message: MENSAGEM,
        requestedSchema: {
          type: 'object',
          properties: { sala: { type: 'string', title: 'Sala', description: 'Sala alternativa escolhida', enum: alternativas } },
          required: ['sala'],
        },
        mode: 'form',
      },
    },
  };
}

describe('servidor MCP: Conflito em reservar_sala (MRTR)', () => {
  let srv: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    url = `${srv.url}/mcp`;
  });
  after(async () => { await srv.parar(); });

  const reservar = (args: Args, capabilities?: unknown) =>
    mcp(url, 'tools/call', { name: 'reservar_sala', arguments: args }, { capabilities });
  const retomar = (args: Args, resposta: unknown, requestState: string) =>
    mcp(url, 'tools/call', {
      name: 'reservar_sala',
      arguments: args,
      inputResponses: { escolha_de_sala: resposta },
      requestState,
    });
  const consultar = (sala: string, inicio: string, fim: string) =>
    mcp(url, 'tools/call', { name: 'consultar_disponibilidade', arguments: { sala, inicio, fim } });

  /** Ocupa a Sala no Intervalo e devolve o input_required de um segundo Pedido para ela. */
  async function pausar(args: Args) {
    const ocupante = await reservar({ ...args, responsavel: 'Ocupante' });
    assert.equal(ocupante.corpo?.result?.structuredContent?.reservado, true, JSON.stringify(ocupante.corpo));
    const r = await reservar(args);
    const resultado = r.corpo?.result;
    assert.equal(resultado?.resultType, 'input_required', JSON.stringify(r.corpo));
    return resultado as { inputRequests: unknown; requestState: string };
  }

  test('Conflito com Alternativas devolve input_required com a Escolha e um requestState', async () => {
    // res-0001 ocupa a garagem das 14:00 as 15:00 do dia 3.
    const r = await reservar({ sala: 'sala-garagem', inicio: em('03', '14:00'), fim: em('03', '15:00'), responsavel: 'Marty' });
    assert.equal(r.status, 200);
    const resultado = r.corpo?.result;
    assert.equal(resultado?.resultType, 'input_required', JSON.stringify(r.corpo));
    assert.deepEqual(resultado.inputRequests, pedidoDeEscolha(['sala-fusca', 'sala-mirante']));
    assert.equal(typeof resultado.requestState, 'string');
    assert.ok(resultado.requestState.length > 0);
  });

  test('Conflito sem nenhuma Alternativa devolve isError, sem elicitation', async () => {
    // Nenhuma Sala tem mais lugares que o Mirante.
    const pedido = { sala: 'sala-mirante', inicio: em('05', '09:00'), fim: em('05', '10:00') };
    const primeira = await reservar({ ...pedido, responsavel: 'Doc' });
    assert.equal(primeira.corpo?.result?.structuredContent?.reservado, true, JSON.stringify(primeira.corpo));

    const r = await reservar({ ...pedido, responsavel: 'Biff' });
    assert.equal(r.status, 200);
    const resultado = r.corpo?.result;
    assert.equal(resultado?.isError, true, JSON.stringify(r.corpo));
    assert.equal(textoDe(resultado), SEM_ALTERNATIVAS);
    assert.equal(resultado.inputRequests, undefined);
  });

  test('retry com accept numa Alternativa selada cria a Reserva nela, com o Pedido selado', async () => {
    const pedido = { sala: 'sala-garagem', inicio: em('06', '10:00'), fim: em('06', '11:00'), responsavel: 'Marty' };
    const pausa = await pausar(pedido);
    assert.deepEqual(pausa.inputRequests, pedidoDeEscolha(['sala-fusca', 'sala-mirante']));

    // Os arguments reenviados nao contam: valem os do requestState.
    const adulterado = { sala: 'sala-aquario', inicio: em('06', '15:00'), fim: em('06', '16:00'), responsavel: 'Biff' };
    const r = await retomar(adulterado, { action: 'accept', content: { sala: 'sala-mirante' } }, pausa.requestState);
    assert.equal(r.status, 200);
    const resultado = r.corpo?.result;
    assert.ok(!resultado?.isError, JSON.stringify(r.corpo));
    assert.equal(resultado.resultType, 'complete');
    const { reserva, ...resto } = resultado.structuredContent;
    assert.match(reserva, /^res-\d{4}$/);
    assert.deepEqual(resto, {
      reservado: true,
      sala: 'sala-mirante',
      inicio: em('06', '10:00'),
      fim: em('06', '11:00'),
      responsavel: 'Marty',
      politica: '2026-11-01',
      motivo: null,
    });

    const consulta = await consultar('sala-mirante', em('06', '10:00'), em('06', '11:00'));
    assert.deepEqual(consulta.corpo?.result?.structuredContent?.conflitos, [
      { id: reserva, inicio: em('06', '10:00'), fim: em('06', '11:00'), responsavel: 'Marty' },
    ]);
  });

  for (const [caso, sala] of [
    ['Sala livre mas fora das Alternativas seladas', 'sala-aquario'],
    ['a propria Sala ocupada', 'sala-garagem'],
    ['Sala inexistente', 'sala-delorean'],
  ] as const) {
    test(`Escolha fora das Alternativas seladas (${caso}) gera nova Pausa, sem Reserva`, async () => {
      const dia = { 'sala-aquario': '11', 'sala-garagem': '12', 'sala-delorean': '13' }[sala];
      const pedido = { sala: 'sala-garagem', inicio: em(dia, '10:00'), fim: em(dia, '11:00'), responsavel: 'Doc' };
      const pausa = await pausar(pedido);

      const r = await retomar(pedido, { action: 'accept', content: { sala } }, pausa.requestState);
      assert.equal(r.status, 200);
      const resultado = r.corpo?.result;
      assert.equal(resultado?.resultType, 'input_required', JSON.stringify(r.corpo));
      assert.deepEqual(resultado.inputRequests, pedidoDeEscolha(['sala-fusca', 'sala-mirante']));
      assert.equal(typeof resultado.requestState, 'string');

      const consulta = await consultar('sala-aquario', pedido.inicio, pedido.fim);
      assert.equal(consulta.corpo?.result?.structuredContent?.livre, true);
    });
  }

  test('Alternativa ocupada entre a Pausa e o retry gera nova Pausa com as Alternativas atualizadas', async () => {
    const pedido = { sala: 'sala-garagem', inicio: em('16', '10:00'), fim: em('16', '11:00'), responsavel: 'Doc' };
    const pausa = await pausar(pedido);
    assert.deepEqual(pausa.inputRequests, pedidoDeEscolha(['sala-fusca', 'sala-mirante']));

    const intruso = await reservar({ sala: 'sala-fusca', inicio: em('16', '10:30'), fim: em('16', '11:30'), responsavel: 'Biff' });
    assert.equal(intruso.corpo?.result?.structuredContent?.reservado, true);

    const r = await retomar(pedido, { action: 'accept', content: { sala: 'sala-fusca' } }, pausa.requestState);
    const resultado = r.corpo?.result;
    assert.equal(resultado?.resultType, 'input_required', JSON.stringify(r.corpo));
    assert.deepEqual(resultado.inputRequests, pedidoDeEscolha(['sala-mirante']));

    // A nova Pausa leva um requestState proprio, que conclui na Alternativa que sobrou.
    const fim = await retomar(pedido, { action: 'accept', content: { sala: 'sala-mirante' } }, resultado.requestState);
    assert.ok(!fim.corpo?.result?.isError, JSON.stringify(fim.corpo));
    assert.equal(fim.corpo.result.structuredContent.sala, 'sala-mirante');
    assert.equal(fim.corpo.result.structuredContent.responsavel, 'Doc');
  });

  test('Alternativas todas ocupadas entre a Pausa e o retry devolvem o erro de falta de Alternativas', async () => {
    const pedido = { sala: 'sala-garagem', inicio: em('17', '10:00'), fim: em('17', '11:00'), responsavel: 'Doc' };
    const pausa = await pausar(pedido);
    for (const sala of ['sala-fusca', 'sala-mirante']) {
      const intruso = await reservar({ ...pedido, sala, responsavel: 'Biff' });
      assert.equal(intruso.corpo?.result?.structuredContent?.reservado, true);
    }

    const r = await retomar(pedido, { action: 'accept', content: { sala: 'sala-fusca' } }, pausa.requestState);
    const resultado = r.corpo?.result;
    assert.equal(resultado?.isError, true, JSON.stringify(r.corpo));
    assert.equal(textoDe(resultado), SEM_ALTERNATIVAS);
  });

  for (const [caso, capabilities] of [
    ['sem capabilities', {}],
    ['so elicitation em url mode', { elicitation: { url: {} } }],
  ] as const) {
    test(`Conflito para cliente sem elicitation em form mode (${caso}) recebe -32021 e HTTP 400`, async () => {
      const r = await reservar({ sala: 'sala-garagem', inicio: em('03', '14:00'), fim: em('03', '15:00'), responsavel: 'Marty' }, capabilities);
      assert.equal(r.status, 400);
      assert.equal(r.corpo?.error?.code, -32021, JSON.stringify(r.corpo));
      assert.deepEqual(r.corpo.error.data?.requiredCapabilities, { elicitation: { form: {} } });
    });
  }

  test('elicitation vazio vale como form mode', async () => {
    const r = await reservar({ sala: 'sala-garagem', inicio: em('03', '14:00'), fim: em('03', '15:00'), responsavel: 'Marty' }, { elicitation: {} });
    assert.equal(r.corpo?.result?.resultType, 'input_required', JSON.stringify(r.corpo));
  });

  test('requestState adulterado recebe -32602, e o legitimo continua valido depois', async () => {
    const pedido = { sala: 'sala-garagem', inicio: em('18', '10:00'), fim: em('18', '11:00'), responsavel: 'Marty' };
    const pausa = await pausar(pedido);
    const estado = pausa.requestState;
    const adulterados = [
      estado.slice(0, -6) + (estado.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA'), // MAC trocado
      estado.slice(0, 10) + (estado[10] === 'A' ? 'B' : 'A') + estado.slice(11), // corpo trocado
      'nada-a-ver',
    ];
    for (const adulterado of adulterados) {
      const r = await retomar(pedido, { action: 'accept', content: { sala: 'sala-fusca' } }, adulterado);
      assert.equal(r.corpo?.error?.code, -32602, `${adulterado}: ${JSON.stringify(r.corpo)}`);
    }
    const livre = await consultar('sala-fusca', pedido.inicio, pedido.fim);
    assert.equal(livre.corpo?.result?.structuredContent?.livre, true);

    const r = await retomar(pedido, { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
    assert.ok(!r.corpo?.result?.isError, JSON.stringify(r.corpo));
    assert.equal(r.corpo.result.structuredContent.sala, 'sala-fusca');
  });

  for (const action of ['decline', 'cancel'] as const) {
    test(`retry com ${action} conclui sem Reserva e sem isError`, async () => {
      const dia = action === 'decline' ? '09' : '10';
      const pedido = { sala: 'sala-garagem', inicio: em(dia, '10:00'), fim: em(dia, '11:00'), responsavel: 'Jennifer' };
      const pausa = await pausar(pedido);

      const r = await retomar(pedido, { action }, pausa.requestState);
      assert.equal(r.status, 200);
      const resultado = r.corpo?.result;
      assert.ok(!resultado?.isError, JSON.stringify(r.corpo));
      assert.equal(resultado.resultType, 'complete');
      const esperado = { reserva: null, reservado: false, sala: null, inicio: null, fim: null, responsavel: null, politica: null, motivo: 'recusado' };
      assert.deepEqual(resultado.structuredContent, esperado);
      assert.deepEqual(JSON.parse(textoDe(resultado)), esperado);

      // Nenhuma das Alternativas foi ocupada.
      for (const sala of ['sala-fusca', 'sala-mirante']) {
        const consulta = await consultar(sala, pedido.inicio, pedido.fim);
        assert.equal(consulta.corpo?.result?.structuredContent?.livre, true, sala);
      }
    });
  }
});
