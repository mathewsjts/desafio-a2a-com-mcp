// Ponto B: o modulo Agenda, puro e sem MCP. Cada teste parte de uma Agenda nova
// carregada dos dados do starter.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { carregarAgenda } from '../src/agenda.ts';

describe('Agenda: Salas', () => {
  test('lista as cinco Salas do starter, na ordem do arquivo', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.listarSalas().map((s) => [s.id, s.capacidade]), [
      ['sala-aquario', 4],
      ['sala-porao', 6],
      ['sala-garagem', 12],
      ['sala-fusca', 12],
      ['sala-mirante', 20],
    ]);
  });
});

// Um dia sem Reservas no starter, para os testes de Politica de uso.
const DIA = '2026-11-10';
const h = (hora: string, offset = '-03:00') => `${DIA}T${hora}:00${offset}`;

describe('Agenda: validar um Pedido', () => {
  test('Pedido valido devolve a Sala e o Intervalo normalizado', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.validarPedido({ sala: 'sala-aquario', inicio: h('09:00'), fim: h('10:00') }), {
      ok: true,
      sala: 'sala-aquario',
      intervalo: { inicio: '2026-11-10T09:00:00-03:00', fim: '2026-11-10T10:00:00-03:00' },
    });
  });

  test('Sala inexistente', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.validarPedido({ sala: 'sala-delorean', inicio: h('09:00'), fim: h('10:00') }), {
      ok: false,
      erro: 'Sala inexistente: sala-delorean',
    });
  });

  for (const valor of [
    '2026-11-10T09:00:00', // sem offset
    '2026-11-10 09:00:00-03:00', // sem o T
    '2026-11-10', // so a data
    'amanha as nove',
    '',
    '2026-13-10T09:00:00-03:00', // mes 13
    '2026-02-30T09:00:00-03:00', // 30 de fevereiro
    '2026-11-10T24:00:00-03:00', // hora 24
    '2026-11-10T09:60:00-03:00', // minuto 60
    '2026-11-10T09:00:00-25:00', // offset fora da faixa
  ]) {
    test(`Data invalida em inicio: ${JSON.stringify(valor)}`, () => {
      const agenda = carregarAgenda();
      assert.deepEqual(agenda.validarPedido({ sala: 'sala-aquario', inicio: valor, fim: h('10:00') }), {
        ok: false,
        erro: `Data invalida: ${valor}`,
      });
    });
  }

  test('Data invalida em fim', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.validarPedido({ sala: 'sala-aquario', inicio: h('09:00'), fim: '2026-11-10T10:00' }), {
      ok: false,
      erro: 'Data invalida: 2026-11-10T10:00',
    });
  });

  test('inicio invalido e reportado antes de fim invalido', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.validarPedido({ sala: 'sala-aquario', inicio: 'x', fim: 'y' }), {
      ok: false,
      erro: 'Data invalida: x',
    });
  });

  test('Sala inexistente vem antes de Data invalida', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.validarPedido({ sala: 'sala-delorean', inicio: 'x', fim: 'y' }), {
      ok: false,
      erro: 'Sala inexistente: sala-delorean',
    });
  });

  test('qualquer offset e aceito e o Intervalo volta normalizado em -03:00', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(
      agenda.validarPedido({ sala: 'sala-aquario', inicio: `${DIA}T12:00:00Z`, fim: `${DIA}T15:30:00+02:00` }),
      { ok: true, sala: 'sala-aquario', intervalo: { inicio: h('09:00'), fim: h('10:30') } },
    );
  });

  test('minutos sem segundos e fracao de segundo sao aceitos', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(
      agenda.validarPedido({ sala: 'sala-aquario', inicio: `${DIA}T09:00-03:00`, fim: `${DIA}T13:00:00.000Z` }),
      { ok: true, sala: 'sala-aquario', intervalo: { inicio: h('09:00'), fim: h('10:00') } },
    );
  });
});

const ERRO_INTERVALO = 'Intervalo invalido: fim deve ser posterior a inicio';
const ERRO_JANELA = 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00';
const ERRO_DURACAO = 'Duracao acima do limite: a politica permite no maximo 2 horas';

/** A mensagem de erro do Pedido na sala-aquario, ou 'ok' quando valido. */
function resultadoDe(inicio: string, fim: string): string {
  const v = carregarAgenda().validarPedido({ sala: 'sala-aquario', inicio, fim });
  return v.ok ? 'ok' : v.erro;
}

describe('Agenda: Politica de uso', () => {
  test('Intervalo invertido', () => {
    assert.equal(resultadoDe(h('10:00'), h('09:00')), ERRO_INTERVALO);
  });

  test('Intervalo vazio (fim igual a inicio)', () => {
    assert.equal(resultadoDe(h('10:00'), h('10:00')), ERRO_INTERVALO);
  });

  test('Intervalo vazio escrito em offsets diferentes e o mesmo instante', () => {
    assert.equal(resultadoDe(h('10:00'), `${DIA}T13:00:00Z`), ERRO_INTERVALO);
  });

  test('Janela de uso: as pontas sao inclusivas', () => {
    assert.equal(resultadoDe(h('08:00'), h('10:00')), 'ok');
    assert.equal(resultadoDe(h('18:00'), h('20:00')), 'ok');
  });

  test('Janela de uso: comecar antes das 08:00', () => {
    assert.equal(resultadoDe(h('07:00'), h('08:00')), ERRO_JANELA);
    assert.equal(resultadoDe(h('07:59'), h('09:00')), ERRO_JANELA);
  });

  test('Janela de uso: terminar depois das 20:00', () => {
    assert.equal(resultadoDe(h('19:00'), h('20:01')), ERRO_JANELA);
    assert.equal(resultadoDe(h('20:00'), h('20:30')), ERRO_JANELA);
  });

  test('Janela de uso: um Intervalo que vira o dia', () => {
    assert.equal(resultadoDe(h('19:00'), '2026-11-11T08:30:00-03:00'), ERRO_JANELA);
  });

  test('Janela de uso: e o horario de Sao Paulo que conta, nao o do offset recebido', () => {
    // 10:00Z = 07:00 em Sao Paulo; 23:00Z = 20:00 em Sao Paulo.
    assert.equal(resultadoDe(`${DIA}T10:00:00Z`, `${DIA}T12:00:00Z`), ERRO_JANELA);
    assert.equal(resultadoDe(`${DIA}T21:00:00Z`, `${DIA}T23:00:00Z`), 'ok');
    // 22:00-03:00 do dia 10 e 01:00Z do dia 11: fora da janela mesmo com o "dia" UTC seguinte.
    assert.equal(resultadoDe('2026-11-11T00:00:00Z', '2026-11-11T01:00:00Z'), ERRO_JANELA);
  });

  test('duracao de exatamente 2h e aceita', () => {
    assert.equal(resultadoDe(h('09:00'), h('11:00')), 'ok');
  });

  test('duracao acima de 2h e recusada, ate por um minuto', () => {
    assert.equal(resultadoDe(h('09:00'), h('11:01')), ERRO_DURACAO);
    assert.equal(resultadoDe(h('09:00'), h('12:00')), ERRO_DURACAO);
  });

  test('ordem: Data invalida vem antes de Intervalo invertido', () => {
    assert.equal(resultadoDe(h('10:00'), '2026-11-10T09:00:00'), 'Data invalida: 2026-11-10T09:00:00');
  });

  test('ordem: Intervalo invertido vem antes da Janela de uso', () => {
    assert.equal(resultadoDe(h('22:00'), h('06:00')), ERRO_INTERVALO);
  });

  test('ordem: Janela de uso vem antes da duracao', () => {
    assert.equal(resultadoDe(h('06:00'), h('12:00')), ERRO_JANELA);
  });
});

// res-0001 do starter: sala-garagem, 2026-11-03 14:00-15:00, Marty.
const RES_0001 = {
  id: 'res-0001',
  sala: 'sala-garagem',
  inicio: '2026-11-03T14:00:00-03:00',
  fim: '2026-11-03T15:00:00-03:00',
  responsavel: 'Marty',
};
const em3 = (hora: string) => `2026-11-03T${hora}:00-03:00`;

describe('Agenda: Conflitos', () => {
  test('o mesmo Intervalo de uma Reserva existente conflita com ela', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.consultarConflitos('sala-garagem', { inicio: em3('14:00'), fim: em3('15:00') }), [RES_0001]);
  });

  test('sobreposicao parcial conflita', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.consultarConflitos('sala-garagem', { inicio: em3('14:59'), fim: em3('16:00') }), [RES_0001]);
    assert.deepEqual(agenda.consultarConflitos('sala-garagem', { inicio: em3('13:00'), fim: em3('14:01') }), [RES_0001]);
    assert.deepEqual(agenda.consultarConflitos('sala-garagem', { inicio: em3('14:15'), fim: em3('14:45') }), [RES_0001]);
  });

  test('Intervalos semiabertos: encostar no inicio ou no fim nao conflita', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.consultarConflitos('sala-garagem', { inicio: em3('15:00'), fim: em3('16:00') }), []);
    assert.deepEqual(agenda.consultarConflitos('sala-garagem', { inicio: em3('13:00'), fim: em3('14:00') }), []);
  });

  test('Reserva de outra Sala no mesmo Intervalo nao conflita', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.consultarConflitos('sala-aquario', { inicio: em3('14:00'), fim: em3('15:00') }), []);
  });

  test('um Pedido em outro offset conflita pelo instante', () => {
    const agenda = carregarAgenda();
    const v = agenda.validarPedido({ sala: 'sala-garagem', inicio: '2026-11-03T17:30:00Z', fim: '2026-11-03T18:30:00Z' });
    assert.ok(v.ok);
    assert.deepEqual(agenda.consultarConflitos(v.sala, v.intervalo), [RES_0001]);
  });
});

describe('Agenda: reservar', () => {
  test('cria Reservas com ids sequenciais depois dos existentes', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.reservar('sala-aquario', { inicio: em3('09:00'), fim: em3('10:00') }, 'Doc'), {
      id: 'res-0003',
      sala: 'sala-aquario',
      inicio: '2026-11-03T09:00:00-03:00',
      fim: '2026-11-03T10:00:00-03:00',
      responsavel: 'Doc',
    });
    assert.equal(agenda.reservar('sala-porao', { inicio: em3('09:00'), fim: em3('10:00') }, 'Marty').id, 'res-0004');
  });

  test('a Reserva criada aparece como Conflito na consulta seguinte', () => {
    const agenda = carregarAgenda();
    const reserva = agenda.reservar('sala-aquario', { inicio: em3('09:00'), fim: em3('10:00') }, 'Doc');
    assert.deepEqual(agenda.consultarConflitos('sala-aquario', { inicio: em3('09:30'), fim: em3('10:30') }), [reserva]);
    assert.deepEqual(agenda.consultarConflitos('sala-aquario', { inicio: em3('10:00'), fim: em3('11:00') }), []);
  });

  test('cada Agenda carregada parte so das Reservas do starter', () => {
    carregarAgenda().reservar('sala-aquario', { inicio: em3('09:00'), fim: em3('10:00') }, 'Doc');
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.consultarConflitos('sala-aquario', { inicio: em3('09:00'), fim: em3('10:00') }), []);
    assert.equal(agenda.reservar('sala-aquario', { inicio: em3('09:00'), fim: em3('10:00') }, 'Doc').id, 'res-0003');
  });

  test('a versao da Politica de uso vem da primeira linha do arquivo', () => {
    assert.equal(carregarAgenda().versaoDaPolitica(), '2026-11-01');
  });
});

describe('Agenda: Alternativas', () => {
  test('Salas livres com capacidade maior ou igual a da pedida, sem a propria Sala', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.alternativas('sala-garagem', { inicio: em3('14:00'), fim: em3('15:00') }), ['sala-fusca', 'sala-mirante']);
  });

  test('no maximo tres, por capacidade crescente e, no empate, por id', () => {
    // garagem e fusca tem 12 lugares; no arquivo a garagem vem antes, no id a fusca.
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.alternativas('sala-aquario', { inicio: em3('09:00'), fim: em3('10:00') }), [
      'sala-porao',
      'sala-fusca',
      'sala-garagem',
    ]);
  });

  test('Sala com Conflito no Intervalo fica de fora, e a lista anda para a proxima', () => {
    const agenda = carregarAgenda();
    // A garagem tem res-0001 das 14:00 as 15:00.
    assert.deepEqual(agenda.alternativas('sala-aquario', { inicio: em3('14:30'), fim: em3('15:30') }), [
      'sala-porao',
      'sala-fusca',
      'sala-mirante',
    ]);
  });

  test('uma Reserva criada passa a contar nas Alternativas seguintes', () => {
    const agenda = carregarAgenda();
    agenda.reservar('sala-mirante', { inicio: em3('14:00'), fim: em3('15:00') }, 'Doc');
    assert.deepEqual(agenda.alternativas('sala-garagem', { inicio: em3('14:00'), fim: em3('15:00') }), ['sala-fusca']);
  });

  test('lista vazia quando nenhuma Sala maior ou igual esta livre', () => {
    const agenda = carregarAgenda();
    assert.deepEqual(agenda.alternativas('sala-mirante', { inicio: em3('09:00'), fim: em3('10:00') }), []);
  });
});
