// Ponto A: a ponte. Um Conflito vira Pausa da Task A2A, e a Escolha (ou a
// Recusa) repete o tools/call com o requestState ecoado. O agente fala com o
// servidor MCP real atraves de um espiao HTTP, que mostra o que o agente mandou
// sem olhar dentro dele. Um processo de cada por describe: cada teste usa um dia
// proprio, porque as Reservas valem ate o fim do processo.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enviarMensagem,
  http,
  iniciarAgente,
  iniciarEspiaoMcp,
  iniciarServidorMcp,
  mcp,
  novoTraceparent,
  obterTask,
  taskDe,
  traceIdDe,
  type EspiaoMcp,
  type Processo,
} from './harness.ts';

const em = (dia: string, hora: string) => `2026-11-${dia}T${hora}:00-03:00`;
const pedido = (sala: string, dia: string, de: string, ate: string, responsavel = 'Marty') =>
  `reservar sala=${sala} inicio=${em(dia, de)} fim=${em(dia, ate)} responsavel=${responsavel}`;

/** Garagem no dia 3, das 14 as 15: ocupada por res-0001 nos dados do starter. */
const PEDIDO_EM_CONFLITO = pedido('sala-garagem', '03', '14:00', '15:00');

describe('agente: a ponte (Pausa e continuacao)', () => {
  let srv: Processo;
  let espiao: EspiaoMcp;
  let agente: Processo;
  let url: string;
  before(async () => {
    srv = await iniciarServidorMcp();
    espiao = await iniciarEspiaoMcp(srv.url);
    agente = await iniciarAgente({ mcpUrl: `${espiao.url}/mcp` });
    url = `${agente.url}/a2a`;
  });
  after(async () => {
    await agente.parar();
    await espiao.parar();
    await srv.parar();
  });

  /** Reserva a Sala direto no servidor MCP (sem passar pelo agente nem pelo espiao). */
  async function ocupar(sala: string, dia: string, de: string, ate: string) {
    const r = await mcp(`${srv.url}/mcp`, 'tools/call', {
      name: 'reservar_sala',
      arguments: { sala, inicio: em(dia, de), fim: em(dia, ate), responsavel: 'Ocupante' },
    });
    assert.equal(r.corpo?.result?.structuredContent?.reservado, true, JSON.stringify(r.corpo));
  }

  /** Abre uma Task com o Pedido e confere que ela parou na Pausa. */
  async function pausar(texto: string, op: { traceparent?: string } = {}) {
    const task = taskDe(await enviarMensagem(url, texto, op));
    assert.equal(task?.status?.state, 'TASK_STATE_INPUT_REQUIRED', JSON.stringify(task));
    return task;
  }

  test('um Pedido em Conflito pausa a Task com exatamente a linha de Alternativas, na ordem do servidor', async () => {
    const r = await enviarMensagem(url, PEDIDO_EM_CONFLITO, { messageId: 'msg-conflito-1' });
    const task = taskDe(r);
    assert.equal(task?.status?.state, 'TASK_STATE_INPUT_REQUIRED', JSON.stringify(r.corpo));

    const status = task.status.message;
    assert.equal(status.role, 'ROLE_AGENT');
    assert.deepEqual(status.parts, [{ text: 'alternativas: sala-fusca, sala-mirante' }]);
    assert.equal(status.taskId, task.id);
    assert.equal(status.contextId, task.contextId);
    assert.deepEqual(task.history, [
      { messageId: 'msg-conflito-1', role: 'ROLE_USER', parts: [{ text: PEDIDO_EM_CONFLITO }] },
      status,
    ]);
    assert.deepEqual(task.artifacts, []);

    assert.deepEqual(taskDe(await obterTask(url, task.id)), task);
  });

  test('escolha=<id> repete o tools/call com id novo, os argumentos originais, inputResponses accept e o requestState ecoado, e conclui na Sala escolhida', async () => {
    await ocupar('sala-garagem', '04', '10:00', '11:00');
    const antes = espiao.trocas().length;
    const pausada = await pausar(pedido('sala-garagem', '04', '10:00', '11:00'));

    const r = await enviarMensagem(url, 'escolha=sala-mirante', { taskId: pausada.id, messageId: 'msg-escolha-1' });
    const task = taskDe(r);
    assert.equal(task?.status?.state, 'TASK_STATE_COMPLETED', JSON.stringify(r.corpo));
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.artifacts[0].name, 'reserva');
    const { reserva, ...resto } = JSON.parse(task.artifacts[0].parts[0].text);
    assert.match(reserva, /^res-\d{4}$/);
    assert.deepEqual(resto, { sala: 'sala-mirante', inicio: em('04', '10:00'), fim: em('04', '11:00'), responsavel: 'Marty', politica: '2026-11-01' });
    assert.deepEqual(task.status.message.parts, [{ text: `Reserva ${reserva} confirmada na sala-mirante.` }]);
    assert.deepEqual(task.history, [
      ...pausada.history,
      { messageId: 'msg-escolha-1', role: 'ROLE_USER', parts: [{ text: 'escolha=sala-mirante' }], taskId: pausada.id },
      task.status.message,
    ]);

    const chamadas = espiao.trocas().slice(antes).filter((t) => t.pedido?.method === 'tools/call');
    assert.equal(chamadas.length, 2, 'o tools/call original e o retry');
    const [original, retry] = chamadas;
    assert.equal(original.resposta?.result?.resultType, 'input_required');
    assert.notEqual(retry.pedido.id, original.pedido.id);
    assert.deepEqual(retry.pedido.params.arguments, original.pedido.params.arguments);
    assert.deepEqual(retry.pedido.params.inputResponses, { escolha_de_sala: { action: 'accept', content: { sala: 'sala-mirante' } } });
    assert.equal(retry.pedido.params.requestState, original.resposta.result.requestState);
    assert.ok(retry.bruto.includes(JSON.stringify(original.resposta.result.requestState)), 'requestState ecoado byte a byte');
  });

  test('escolha=recusar repete o tools/call com decline e cancela a Task sem Reserva', async () => {
    await ocupar('sala-garagem', '05', '10:00', '11:00');
    const antes = espiao.trocas().length;
    const pausada = await pausar(pedido('sala-garagem', '05', '10:00', '11:00'));

    const task = taskDe(await enviarMensagem(url, 'escolha=recusar', { taskId: pausada.id }));
    assert.equal(task?.status?.state, 'TASK_STATE_CANCELED', JSON.stringify(task));
    assert.equal(task.status.message.role, 'ROLE_AGENT');
    assert.ok(task.status.message.parts[0].text.length > 0);
    assert.deepEqual(task.artifacts, []);
    assert.equal(task.history.length, 4);

    const [original, retry] = espiao.trocas().slice(antes).filter((t) => t.pedido?.method === 'tools/call');
    assert.deepEqual(retry.pedido.params.inputResponses, { escolha_de_sala: { action: 'decline' } });
    assert.equal(retry.pedido.params.requestState, original.resposta.result.requestState);
    assert.equal(retry.resposta?.result?.structuredContent?.reservado, false);

    // A mensagem de cancelamento e fixa.
    await ocupar('sala-garagem', '05', '12:00', '13:00');
    const outra = await pausar(pedido('sala-garagem', '05', '12:00', '13:00'));
    const cancelada = taskDe(await enviarMensagem(url, 'escolha=recusar', { taskId: outra.id }));
    assert.deepEqual(cancelada.status.message.parts, task.status.message.parts);
  });

  test('texto qualquer ou Escolha fora do enum durante a Pausa mantem a Task pausada, repete as Alternativas e nao chama o MCP', async () => {
    await ocupar('sala-garagem', '06', '10:00', '11:00');
    const pausada = await pausar(pedido('sala-garagem', '06', '10:00', '11:00'));
    const trocasAntes = espiao.trocas().length;
    const logsAntes = srv.logs().length;

    let historico = pausada.history;
    for (const texto of ['oi, tudo bem?', 'escolha=sala-aquario', 'escolha=', 'escolha sala-fusca', 'reservar sala=sala-fusca']) {
      const task = taskDe(await enviarMensagem(url, texto, { taskId: pausada.id, messageId: `msg-${historico.length}` }));
      assert.equal(task?.status?.state, 'TASK_STATE_INPUT_REQUIRED', `${texto}: ${JSON.stringify(task)}`);
      assert.deepEqual(task.status.message.parts, [{ text: 'alternativas: sala-fusca, sala-mirante' }]);
      assert.deepEqual(task.history, [
        ...historico,
        { messageId: `msg-${historico.length}`, role: 'ROLE_USER', parts: [{ text: texto }], taskId: pausada.id },
        task.status.message,
      ]);
      historico = task.history;
    }
    assert.equal(espiao.trocas().length, trocasAntes, 'nenhum request MCP durante as respostas invalidas');
    assert.equal(srv.logs().length, logsAntes);

    // A Pausa continua valida depois das respostas invalidas.
    const concluida = taskDe(await enviarMensagem(url, 'escolha=sala-fusca', { taskId: pausada.id }));
    assert.equal(concluida.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(concluida));
  });

  test('se a Alternativa escolhida foi ocupada por outra Task, a Task volta a Pausa com as novas Alternativas e a continuacao nova', async () => {
    await ocupar('sala-garagem', '09', '10:00', '11:00');
    const antes = espiao.trocas().length;
    const pausada = await pausar(pedido('sala-garagem', '09', '10:00', '11:00'));

    const outra = taskDe(await enviarMensagem(url, pedido('sala-fusca', '09', '10:00', '11:00', 'Biff')));
    assert.equal(outra.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(outra));

    const repausada = taskDe(await enviarMensagem(url, 'escolha=sala-fusca', { taskId: pausada.id }));
    assert.equal(repausada.status.state, 'TASK_STATE_INPUT_REQUIRED', JSON.stringify(repausada));
    assert.deepEqual(repausada.status.message.parts, [{ text: 'alternativas: sala-mirante' }]);
    assert.deepEqual(repausada.artifacts, []);

    // A Escolha agora e conferida contra o enum novo.
    const invalida = taskDe(await enviarMensagem(url, 'escolha=sala-fusca', { taskId: pausada.id }));
    assert.deepEqual(invalida.status.message.parts, [{ text: 'alternativas: sala-mirante' }]);

    const concluida = taskDe(await enviarMensagem(url, 'escolha=sala-mirante', { taskId: pausada.id }));
    assert.equal(concluida.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(concluida));
    assert.equal(JSON.parse(concluida.artifacts[0].parts[0].text).sala, 'sala-mirante');

    const chamadas = espiao.trocas().slice(antes).filter((t) => t.pedido?.method === 'tools/call');
    const daTask = chamadas.filter((t) => t.pedido.params.arguments.responsavel === 'Marty');
    assert.equal(daTask.length, 3, 'original, retry que repausou e retry final');
    const [original, primeiroRetry, segundoRetry] = daTask;
    assert.equal(primeiroRetry.pedido.params.requestState, original.resposta.result.requestState);
    assert.equal(primeiroRetry.resposta?.result?.resultType, 'input_required');
    assert.equal(segundoRetry.pedido.params.requestState, primeiroRetry.resposta.result.requestState);
    assert.notEqual(segundoRetry.pedido.params.requestState, original.resposta.result.requestState);
    assert.deepEqual(segundoRetry.pedido.params.arguments, original.pedido.params.arguments);
    assert.equal(new Set(daTask.map((t) => t.pedido.id)).size, 3);
  });

  test('a continuacao reaproveita o trace-id da Task mesmo com outro traceparent, e o stderr do MCP mostra o par de tools/call com ids diferentes', async () => {
    const traceDaTask = 'b1b2c3d4e5f60718293a4b5c6d7e8f91';
    const traceDaContinuacao = 'c1b2c3d4e5f60718293a4b5c6d7e8f92';
    await ocupar('sala-garagem', '10', '10:00', '11:00');
    const pausada = await pausar(pedido('sala-garagem', '10', '10:00', '11:00'), { traceparent: novoTraceparent(traceDaTask) });

    const r = await enviarMensagem(url, 'escolha=sala-mirante', { taskId: pausada.id, traceparent: novoTraceparent(traceDaContinuacao) });
    assert.equal(taskDe(r)?.status?.state, 'TASK_STATE_COMPLETED', JSON.stringify(r.corpo));

    const chamadas = () => srv.logs().filter((l) => l.method === 'tools/call' && traceIdDe(l.traceparent) === traceDaTask);
    await srv.esperarLog(() => chamadas().length >= 2);
    const linhas = srv.logs().filter((l) => traceIdDe(l.traceparent) === traceDaTask);
    assert.deepEqual(linhas.map((l) => l.method), ['tools/list', 'resources/read', 'tools/call', 'tools/call'], 'o retry nao repete a descoberta');
    const [original, retry] = chamadas();
    assert.notEqual(original.id, retry.id);
    assert.notEqual(String(original.traceparent).split('-')[2], String(retry.traceparent).split('-')[2], 'span-id novo no retry');
    assert.deepEqual(srv.logs().filter((l) => traceIdDe(l.traceparent) === traceDaContinuacao), []);
  });

  test('o requestState nao aparece em nenhuma resposta A2A: card, SendMessage, GetTask, historico ou artifact', async () => {
    await ocupar('sala-garagem', '11', '10:00', '11:00');
    const antes = espiao.trocas().length;
    const respostas = [await enviarMensagem(url, pedido('sala-garagem', '11', '10:00', '11:00'))];
    const id = taskDe(respostas[0]).id;
    respostas.push(await obterTask(url, id));
    respostas.push(await enviarMensagem(url, 'escolha=sala-aquario', { taskId: id }));
    respostas.push(await enviarMensagem(url, 'escolha=sala-fusca', { taskId: id }));
    respostas.push(await obterTask(url, id));
    respostas.push(await http(`${agente.url}/.well-known/agent-card.json`, { metodo: 'GET' }));
    assert.equal(taskDe(respostas[4]).status.state, 'TASK_STATE_COMPLETED');

    const [original] = espiao.trocas().slice(antes).filter((t) => t.pedido?.method === 'tools/call');
    const requestState: string = original.resposta.result.requestState;
    const [, payload, mac] = requestState.split('.');
    for (const r of respostas) {
      for (const pedaco of [requestState, payload, mac]) assert.ok(!r.bruto.includes(pedaco), `vazou em: ${r.bruto.slice(0, 200)}`);
      assert.ok(!r.bruto.includes('requestState'));
    }
  });

  test('duas Tasks pausadas ao mesmo tempo concluem, cada uma, com a sua propria Reserva', async () => {
    await ocupar('sala-garagem', '12', '10:00', '11:00');
    await ocupar('sala-garagem', '12', '14:00', '15:00');
    const a = await pausar(pedido('sala-garagem', '12', '10:00', '11:00', 'Lorraine'));
    const b = await pausar(pedido('sala-garagem', '12', '14:00', '15:00', 'George'));

    const [ra, rb] = (await Promise.all([
      enviarMensagem(url, 'escolha=sala-mirante', { taskId: a.id }),
      enviarMensagem(url, 'escolha=sala-fusca', { taskId: b.id }),
    ])).map(taskDe);
    assert.equal(ra.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(ra));
    assert.equal(rb.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(rb));
    const reservaA = JSON.parse(ra.artifacts[0].parts[0].text);
    const reservaB = JSON.parse(rb.artifacts[0].parts[0].text);
    assert.notEqual(reservaA.reserva, reservaB.reserva);
    assert.deepEqual([reservaA.sala, reservaA.inicio, reservaA.responsavel], ['sala-mirante', em('12', '10:00'), 'Lorraine']);
    assert.deepEqual([reservaB.sala, reservaB.inicio, reservaB.responsavel], ['sala-fusca', em('12', '14:00'), 'George']);
  });

  test('duas Pausas para o mesmo Pedido produzem mensagens identicas byte a byte', async () => {
    await ocupar('sala-porao', '13', '10:00', '11:00');
    const texto = pedido('sala-porao', '13', '10:00', '11:00');
    const [p1, p2] = [await pausar(texto), await pausar(texto)];
    assert.notEqual(p1.id, p2.id);
    assert.equal(JSON.stringify(p2.status.message.parts), JSON.stringify(p1.status.message.parts));
    // Ordem do servidor: capacidade, depois id (fusca e garagem tem 12 lugares).
    assert.deepEqual(p1.status.message.parts, [{ text: 'alternativas: sala-fusca, sala-garagem, sala-mirante' }]);
  });
});
