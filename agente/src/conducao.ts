// Conducao da Task: liga o lado A2A (Task, maquina de estados) ao host MCP.
// Nao ha regra de sala aqui. O agente so traduz: Pedido -> tools/call, e o
// resultado do tools/call -> estado da Task (`interpretarResultado`).

import { isInputRequiredResult, type InputRequiredResult } from '@modelcontextprotocol/client';
import { interpretarResposta } from './escolha.ts';
import type { HostMcp, ResultadoTool } from './host-mcp.ts';
import { interpretarPedido, PEDIDO_INVALIDO, type Pedido } from './pedido.ts';
import { anexarArtifact, mover, responder, type Continuacao, type Mensagem, type Task } from './task.ts';

/** O que a Reserva concluida leva no artifact `reserva`. */
export type ReservaFeita = {
  reserva: string;
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
};

/** O que a Pausa guarda do input_required: tudo opaco, menos o enum da Escolha. */
export type SolicitacaoDeEscolha = Pick<Continuacao, 'chave' | 'requestState' | 'alternativas'>;

/** Desfecho de um `tools/call reservar_sala`, ja na linguagem da Task. */
export type Desfecho =
  | { tipo: 'concluida'; reserva: ReservaFeita }
  | { tipo: 'pausa'; escolha: SolicitacaoDeEscolha }
  /** `reservado: false`: so vira CANCELED como resposta a uma Recusa. */
  | { tipo: 'sem-reserva'; mensagem: string }
  | { tipo: 'falha'; mensagem: string };

/** Mensagem fixa do cancelamento depois de uma Recusa. */
export const MENSAGEM_DE_RECUSA = 'Recusa registrada: Task cancelada sem Reserva.';

/**
 * A ponte, lado de entrada: a chave unica de `inputRequests` e o `enum` (ou
 * `const`) de `requestedSchema.properties.sala`, na ordem do servidor. O
 * `requestState` e guardado como veio; o agente nunca o decodifica.
 */
function lerSolicitacaoDeEscolha(r: InputRequiredResult): SolicitacaoDeEscolha | undefined {
  const chaves = Object.keys(r.inputRequests ?? {});
  if (chaves.length !== 1 || typeof r.requestState !== 'string') return undefined;
  const [chave] = chaves;
  const solicitacao = r.inputRequests?.[chave] as { params?: { requestedSchema?: { properties?: Record<string, unknown> } } };
  const sala = solicitacao?.params?.requestedSchema?.properties?.sala as { enum?: unknown; const?: unknown } | undefined;
  const alternativas = Array.isArray(sala?.enum) ? sala.enum : sala?.const !== undefined ? [sala.const] : [];
  if (alternativas.length === 0 || !alternativas.every((a) => typeof a === 'string')) return undefined;
  return { chave, requestState: r.requestState, alternativas };
}

/** Texto concatenado dos blocos `content` de um resultado de tool. */
const textoDoResultado = (r: { content?: unknown }) =>
  (Array.isArray(r.content) ? r.content : [])
    .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
    .join(' ');

/**
 * O ponto em que o resultado MCP vira estado A2A. Erros de JSON-RPC e de
 * transporte nao chegam aqui: lancam em `host.reservarSala` e viram falha em
 * `executarPedido` ou `continuar`.
 */
export function interpretarResultado(r: ResultadoTool): Desfecho {
  if (isInputRequiredResult(r)) {
    const escolha = lerSolicitacaoDeEscolha(r);
    if (!escolha) return { tipo: 'falha', mensagem: `input_required inesperado de reservar_sala: ${JSON.stringify(r.inputRequests)}` };
    return { tipo: 'pausa', escolha };
  }
  if (r.isError) return { tipo: 'falha', mensagem: textoDoResultado(r) };
  const estruturado = (r.structuredContent ?? {}) as Record<string, unknown>;
  if (estruturado.reservado === true) {
    return {
      tipo: 'concluida',
      reserva: {
        reserva: String(estruturado.reserva),
        sala: String(estruturado.sala),
        inicio: String(estruturado.inicio),
        fim: String(estruturado.fim),
        responsavel: String(estruturado.responsavel),
      },
    };
  }
  if (estruturado.reservado === false) return { tipo: 'sem-reserva', mensagem: textoDoResultado(r) };
  return { tipo: 'falha', mensagem: `Resultado inesperado de reservar_sala: ${textoDoResultado(r)}` };
}

/** A linha da Pausa: so os ids, na ordem do enum, sem nada variavel. */
export const linhaDeAlternativas = (alternativas: readonly string[]) => `alternativas: ${alternativas.join(', ')}`;

/**
 * A rodada de `tools/call` cujo Desfecho se aplica: os `argumentos` do
 * `tools/call` original e a `politica` lida (guardados na Pausa para o retry),
 * e se ela foi o retry com `decline` de uma continuacao (`recusa`), a unica
 * rodada que leva a CANCELED.
 */
type Rodada = Pick<Continuacao, 'argumentos' | 'politica'> & { recusa: boolean };

/** Aplica o Desfecho a Task (que esta em WORKING). */
function aplicar(task: Task, d: Desfecho, { argumentos, politica, recusa }: Rodada): void {
  switch (d.tipo) {
    case 'pausa':
      // A ponte: input_required -> TASK_STATE_INPUT_REQUIRED, com a continuacao MCP guardada so no store.
      task.continuacao = { ...d.escolha, argumentos, politica };
      responder(task, 'TASK_STATE_INPUT_REQUIRED', linhaDeAlternativas(d.escolha.alternativas));
      return;
    case 'concluida': {
      const { reserva, sala, inicio, fim, responsavel } = d.reserva;
      anexarArtifact(task, 'reserva', JSON.stringify({ reserva, sala, inicio, fim, responsavel, politica }));
      responder(task, 'TASK_STATE_COMPLETED', `Reserva ${reserva} confirmada na ${sala}.`);
      return;
    }
    case 'sem-reserva':
      // `reservado: false` fora do retry com decline e um resultado inesperado.
      if (recusa) responder(task, 'TASK_STATE_CANCELED', MENSAGEM_DE_RECUSA);
      else responder(task, 'TASK_STATE_FAILED', d.mensagem);
      return;
    case 'falha':
      responder(task, 'TASK_STATE_FAILED', d.mensagem);
      return;
  }
}

const mensagemDeErro = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Conducao = {
  /** Conduz uma Task recem-aberta (SUBMITTED) com o texto do Pedido, ate um estado que espera o cliente ou terminal. */
  executarPedido(task: Task, texto: string): Promise<void>;
  /**
   * Conduz a resposta do cliente a uma Pausa (Task em INPUT_REQUIRED): registra
   * a mensagem no historico e, numa Escolha, repete o tools/call guardado.
   */
  continuar(task: Task, mensagem: Mensagem, texto: string): Promise<void>;
};

export function criarConducao(host: HostMcp): Conducao {
  /** Descoberta, Politica e tools/call, nesta ordem, a cada Task nova. */
  async function reservar(task: Task, pedido: Pedido): Promise<void> {
    await host.descobrirTools(task.traceId);
    const politica = await host.lerVersaoDaPolitica(task.traceId);
    const resultado = await host.reservarSala(pedido, task.traceId);
    aplicar(task, interpretarResultado(resultado), { argumentos: pedido, politica, recusa: false });
  }

  return {
    async executarPedido(task, texto) {
      mover(task, 'TASK_STATE_WORKING');
      const pedido = interpretarPedido(texto);
      if (!pedido) {
        responder(task, 'TASK_STATE_FAILED', PEDIDO_INVALIDO);
        return;
      }
      try {
        await reservar(task, pedido);
      } catch (e) {
        // Erro de JSON-RPC ou falha de transporte do MCP.
        responder(task, 'TASK_STATE_FAILED', mensagemDeErro(e));
      }
    },

    async continuar(task, mensagem, texto) {
      const continuacao = task.continuacao;
      if (!continuacao) throw new Error(`Task ${task.id} sem continuacao MCP guardada (${task.estado})`);
      task.historico.push(mensagem);
      const resposta = interpretarResposta(texto, continuacao.alternativas);
      if (!resposta) {
        // Resposta invalida: a Pausa fica como esta, sem chamar o MCP.
        responder(task, 'TASK_STATE_INPUT_REQUIRED', linhaDeAlternativas(continuacao.alternativas));
        return;
      }
      // Sai da Pausa antes do primeiro await: uma segunda continuacao da mesma
      // Task, chegando durante o retry, ja encontra WORKING.
      mover(task, 'TASK_STATE_WORKING');
      task.continuacao = undefined;
      const { chave, requestState, argumentos, politica } = continuacao;
      try {
        // A ponte, lado de saida: o requestState volta ao servidor como veio, com o trace-id da Task.
        const recusa = resposta.tipo === 'recusa';
        const inputResponses = {
          [chave]: recusa ? { action: 'decline' } : { action: 'accept', content: { sala: resposta.sala } },
        };
        const resultado = await host.reservarSala(argumentos, task.traceId, { inputResponses, requestState });
        aplicar(task, interpretarResultado(resultado), { argumentos, politica, recusa });
      } catch (e) {
        responder(task, 'TASK_STATE_FAILED', mensagemDeErro(e));
      }
    },
  };
}
