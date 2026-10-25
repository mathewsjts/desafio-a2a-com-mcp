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
export type PedidoDeEscolha = Omit<Continuacao, 'argumentos'>;

/** Desfecho de um `tools/call reservar_sala`, ja na linguagem da Task. */
export type Desfecho =
  | { tipo: 'concluida'; reserva: ReservaFeita }
  | { tipo: 'pausa'; escolha: PedidoDeEscolha }
  | { tipo: 'recusada' }
  | { tipo: 'falha'; mensagem: string };

/** Mensagem fixa do cancelamento depois de uma Recusa. */
export const MENSAGEM_DE_RECUSA = 'Recusa registrada: Task cancelada sem Reserva.';

/**
 * A ponte, lado de entrada: a chave unica de `inputRequests` e o `enum` (ou
 * `const`) de `requestedSchema.properties.sala`, na ordem do servidor. O
 * `requestState` e guardado como veio; o agente nunca o decodifica.
 */
function lerPedidoDeEscolha(r: InputRequiredResult): PedidoDeEscolha | undefined {
  const chaves = Object.keys(r.inputRequests ?? {});
  if (chaves.length !== 1 || typeof r.requestState !== 'string') return undefined;
  const [chave] = chaves;
  const pedido = r.inputRequests?.[chave] as { params?: { requestedSchema?: { properties?: Record<string, unknown> } } };
  const sala = pedido?.params?.requestedSchema?.properties?.sala as { enum?: unknown; const?: unknown } | undefined;
  const alternativas = Array.isArray(sala?.enum) ? sala.enum : sala?.const !== undefined ? [sala.const] : [];
  if (alternativas.length === 0 || !alternativas.every((a) => typeof a === 'string')) return undefined;
  return { chave, requestState: r.requestState, alternativas };
}

const texto = (r: { content?: unknown }) =>
  (Array.isArray(r.content) ? r.content : [])
    .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
    .join(' ');

/**
 * O ponto em que o resultado MCP vira estado A2A. Erros de JSON-RPC e de
 * transporte nao chegam aqui: lancam em `host.reservarSala` e viram falha em
 * `executar`.
 */
export function interpretarResultado(r: ResultadoTool): Desfecho {
  if (isInputRequiredResult(r)) {
    const escolha = lerPedidoDeEscolha(r);
    if (!escolha) return { tipo: 'falha', mensagem: `input_required inesperado de reservar_sala: ${JSON.stringify(r.inputRequests)}` };
    return { tipo: 'pausa', escolha };
  }
  if (r.isError) return { tipo: 'falha', mensagem: texto(r) };
  const s = (r.structuredContent ?? {}) as Record<string, unknown>;
  if (s.reservado === true) {
    return {
      tipo: 'concluida',
      reserva: {
        reserva: String(s.reserva),
        sala: String(s.sala),
        inicio: String(s.inicio),
        fim: String(s.fim),
        responsavel: String(s.responsavel),
      },
    };
  }
  if (s.reservado === false) return { tipo: 'recusada' };
  return { tipo: 'falha', mensagem: `Resultado inesperado de reservar_sala: ${texto(r)}` };
}

/** A linha da Pausa: so os ids, na ordem do enum, sem nada variavel. */
export const linhaDeAlternativas = (alternativas: readonly string[]) => `alternativas: ${alternativas.join(', ')}`;

/**
 * Aplica o Desfecho a Task (que esta em WORKING). `argumentos` sao os do
 * `tools/call` original, guardados na Pausa para o retry.
 */
function aplicar(task: Task, d: Desfecho, politica: string, argumentos: Record<string, unknown>): void {
  switch (d.tipo) {
    case 'pausa':
      // A ponte: input_required -> TASK_STATE_INPUT_REQUIRED, com a continuacao MCP guardada so no store.
      task.continuacao = { ...d.escolha, argumentos };
      responder(task, 'TASK_STATE_INPUT_REQUIRED', linhaDeAlternativas(d.escolha.alternativas));
      return;
    case 'concluida': {
      const { reserva, sala, inicio, fim, responsavel } = d.reserva;
      anexarArtifact(task, 'reserva', JSON.stringify({ reserva, sala, inicio, fim, responsavel, politica }));
      responder(task, 'TASK_STATE_COMPLETED', `Reserva ${reserva} confirmada na ${sala}.`);
      return;
    }
    case 'recusada':
      responder(task, 'TASK_STATE_CANCELED', MENSAGEM_DE_RECUSA);
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
    task.versaoDaPolitica = politica;
    const argumentos = { ...pedido };
    const resultado = await host.reservarSala(argumentos, task.traceId);
    aplicar(task, interpretarResultado(resultado), politica, argumentos);
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
      const { chave, requestState, argumentos } = continuacao;
      try {
        // A ponte, lado de saida: o requestState volta ao servidor como veio, com o trace-id da Task.
        const inputResponses = {
          [chave]: resposta.tipo === 'recusa' ? { action: 'decline' } : { action: 'accept', content: { sala: resposta.sala } },
        };
        const resultado = await host.reservarSala(argumentos, task.traceId, { inputResponses, requestState });
        aplicar(task, interpretarResultado(resultado), task.versaoDaPolitica ?? '', argumentos);
      } catch (e) {
        responder(task, 'TASK_STATE_FAILED', mensagemDeErro(e));
      }
    },
  };
}
