// Ponto A: o Agent Card do agente, so por HTTP.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { http, iniciarAgente, type Processo } from './harness.ts';

describe('agente: Agent Card', () => {
  let agente: Processo;
  before(async () => {
    agente = await iniciarAgente({ env: { AGENT_CARD_URL: 'http://agente.exemplo:7300/a2a' } });
  });
  after(async () => { await agente.parar(); });

  test('o well-known devolve o card v1.0 com a URL configurada, capabilities falsas e a skill reservar-sala', async () => {
    const r = await http(`${agente.url}/.well-known/agent-card.json`, { metodo: 'GET' });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /application\/json/);
    assert.deepEqual(r.corpo, {
      name: 'Central de Salas',
      description: 'Reserva salas de reuniao da Hill Valley Tech.',
      provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
      version: '1.0.0',
      supportedInterfaces: [{ url: 'http://agente.exemplo:7300/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [
        {
          id: 'reservar-sala',
          name: 'Reservar sala',
          description: 'Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.',
          tags: ['salas', 'agenda'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
          examples: [
            'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty',
          ],
        },
      ],
    });
  });
});
