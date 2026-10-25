// Conducao da Task: liga o lado A2A (Task, maquina de estados) ao host MCP.
// Nao ha regra de sala aqui. O agente so traduz: Pedido -> tools/call, e o
// resultado do tools/call -> estado da Task (`interpretarResultado`).

import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type { HostMcp, ResultadoTool } from './host-mcp.ts';
import { interpretarPedido, PEDIDO_INVALIDO, type Pedido } from './pedido.ts';
import { anexarArtifact, mover, responder, type Task } from './task.ts';

/** O que a Reserva concluida leva no artifact `reserva`. */
export type ReservaFeita = {
  reserva: string;
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
};

/**
 * Desfecho de um `tools/call reservar_sala`, ja na linguagem da Task.
 * Ticket 09 acrescenta a Pausa (input_required) e a Recusa (reservado: false).
 */
export type Desfecho =
  | { tipo: 'concluida'; reserva: ReservaFeita }
  | { tipo: 'falha'; mensagem: string };

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
    // Ticket 09: a ponte (input_required -> TASK_STATE_INPUT_REQUIRED).
    return { tipo: 'falha', mensagem: 'input_required ainda nao suportado pelo agente' };
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
  return { tipo: 'falha', mensagem: `Resultado inesperado de reservar_sala: ${texto(r)}` };
}

/** Aplica o Desfecho a Task (que esta em WORKING). */
function aplicar(task: Task, d: Desfecho, politica: string): void {
  switch (d.tipo) {
    case 'concluida': {
      const { reserva, sala, inicio, fim, responsavel } = d.reserva;
      anexarArtifact(task, 'reserva', JSON.stringify({ reserva, sala, inicio, fim, responsavel, politica }));
      responder(task, 'TASK_STATE_COMPLETED', `Reserva ${reserva} confirmada na ${sala}.`);
      return;
    }
    case 'falha':
      responder(task, 'TASK_STATE_FAILED', d.mensagem);
      return;
  }
}

const mensagemDeErro = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Conducao = {
  /** Conduz uma Task recem-aberta (SUBMITTED) com o texto do Pedido, ate um estado que espera o cliente ou terminal. */
  executarPedido(task: Task, texto: string): Promise<void>;
};

export function criarConducao(host: HostMcp): Conducao {
  /** Descoberta, Politica e tools/call, nesta ordem, a cada Task nova. */
  async function reservar(task: Task, pedido: Pedido): Promise<void> {
    await host.descobrirTools(task.traceId);
    const politica = await host.lerVersaoDaPolitica(task.traceId);
    task.versaoDaPolitica = politica;
    const resultado = await host.reservarSala({ ...pedido }, task.traceId);
    aplicar(task, interpretarResultado(resultado), politica);
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
        // Erro de JSON-RPC ou falha de transporte do MCP (ticket 08 refina e testa).
        responder(task, 'TASK_STATE_FAILED', mensagemDeErro(e));
      }
    },
  };
}
