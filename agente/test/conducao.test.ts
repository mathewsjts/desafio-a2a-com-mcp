// Ponto B do agente: a Conducao contra um host MCP falso, para os desfechos
// que o servidor MCP real nunca produz (reservado:false fora de uma Recusa).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { criarConducao, MENSAGEM_DE_RECUSA } from '../src/conducao.ts';
import type { HostMcp, ResultadoTool, Retry } from '../src/host-mcp.ts';
import { criarStoreDeTasks, type Mensagem, type Task } from '../src/task.ts';

const PEDIDO = 'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty';

const TEXTO_NAO_RESERVADO = '{"reservado":false,"motivo":"recusado"}';
const naoReservado: ResultadoTool = {
  content: [{ type: 'text', text: TEXTO_NAO_RESERVADO }],
  structuredContent: { reserva: null, reservado: false, motivo: 'recusado' },
};

const pausa: ResultadoTool = {
  resultType: 'input_required',
  requestState: 'estado-opaco',
  inputRequests: {
    'escolha_de_sala': {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Escolha uma alternativa.',
        requestedSchema: { type: 'object', properties: { sala: { type: 'string', enum: ['sala-fusca', 'sala-mirante'] } }, required: ['sala'] },
      },
    },
  },
} as unknown as ResultadoTool;

/** Host MCP que responde cada `tools/call` com o proximo resultado da lista e guarda os retries. */
function hostFalso(resultados: ResultadoTool[]) {
  const retries: (Retry | undefined)[] = [];
  const host: HostMcp = {
    async descobrirTools() {},
    async lerVersaoDaPolitica() { return '2026-11-01'; },
    async reservarSala(_argumentos, _traceId, retry) {
      retries.push(retry);
      const r = resultados.shift();
      if (!r) throw new Error('tools/call alem do roteiro');
      return r;
    },
  };
  return { host, retries };
}

const mensagemDoUsuario = (texto: string): Mensagem => ({ messageId: 'msg-1', role: 'ROLE_USER', parts: [{ text: texto }] });

async function abrir(host: HostMcp): Promise<{ task: Task; conducao: ReturnType<typeof criarConducao> }> {
  const conducao = criarConducao(host);
  const task = criarStoreDeTasks().abrir(mensagemDoUsuario(PEDIDO), '4bf92f3577b34da6a3ce929d0e0e4736');
  await conducao.executarPedido(task, PEDIDO);
  return { task, conducao };
}

const textoDoStatus = (task: Task) => task.mensagemDeStatus?.parts.map((p) => p.text).join(' ');

describe('agente: so a Recusa cancela a Task', () => {
  test('reservado:false na primeira rodada termina em FAILED com o texto do resultado, nao em CANCELED', async () => {
    const { task } = await abrir(hostFalso([naoReservado]).host);
    assert.equal(task.estado, 'TASK_STATE_FAILED');
    assert.equal(textoDoStatus(task), TEXTO_NAO_RESERVADO);
    assert.deepEqual(task.artifacts, []);
  });

  test('reservado:false no retry de uma Escolha termina em FAILED com o texto do resultado', async () => {
    const { host } = hostFalso([pausa, naoReservado]);
    const { task, conducao } = await abrir(host);
    assert.equal(task.estado, 'TASK_STATE_INPUT_REQUIRED');
    await conducao.continuar(task, mensagemDoUsuario('escolha=sala-fusca'), 'escolha=sala-fusca');
    assert.equal(task.estado, 'TASK_STATE_FAILED');
    assert.equal(textoDoStatus(task), TEXTO_NAO_RESERVADO);
  });

  test('o retry com decline de uma continuacao termina em CANCELED com a mensagem da Recusa', async () => {
    const { host, retries } = hostFalso([pausa, naoReservado]);
    const { task, conducao } = await abrir(host);
    await conducao.continuar(task, mensagemDoUsuario('escolha=recusar'), 'escolha=recusar');
    assert.deepEqual(retries.at(-1)?.inputResponses, { escolha_de_sala: { action: 'decline' } });
    assert.equal(task.estado, 'TASK_STATE_CANCELED');
    assert.equal(textoDoStatus(task), MENSAGEM_DE_RECUSA);
  });
});
