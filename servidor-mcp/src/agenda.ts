// Modulo Agenda: o unico lugar com as regras de sala (Politica de uso, Conflito).
// Livre de MCP: recebe e devolve valores simples, e os erros de dominio sao as
// mensagens exatas do contrato.

import { lerReservas, lerSalas, lerVersaoDaPolitica, type Reserva, type Sala } from './dados.ts';

export type { Reserva, Sala };

/** Intervalo normalizado: ISO 8601 com offset `-03:00`. */
export type Intervalo = { inicio: string; fim: string };

export type Pedido = { sala: string; inicio: string; fim: string };

export type Validacao = { ok: true; sala: string; intervalo: Intervalo } | { ok: false; erro: string };

export type Agenda = {
  listarSalas(): Sala[];
  validarPedido(pedido: Pedido): Validacao;
  /** Reservas da Sala que se sobrepoem ao Intervalo (semiaberto), na ordem da Agenda. */
  consultarConflitos(sala: string, intervalo: Intervalo): Reserva[];
  /**
   * Alternativas a uma Sala ocupada: outras Salas livres no Intervalo, com
   * capacidade maior ou igual a da pedida, por capacidade crescente e depois
   * `id`, no maximo tres.
   */
  alternativas(sala: string, intervalo: Intervalo): string[];
  /**
   * Cria a Reserva com o proximo id `res-NNNN` e a guarda em memoria. Nao
   * revalida: quem chama ja passou por `validarPedido` e checou os Conflitos.
   */
  reservar(sala: string, intervalo: Intervalo, responsavel: string): Reserva;
  /** Versao vigente da Politica de uso (relida a cada chamada). */
  versaoDaPolitica(): string;
};

const HORA_MS = 60 * 60 * 1000;

// Politica de uso (dados/politica-de-uso.md). Mensagens exatas do contrato.
const JANELA_ABRE_MS = 8 * HORA_MS;
const JANELA_FECHA_MS = 20 * HORA_MS;
const DURACAO_MAXIMA_MS = 2 * HORA_MS;
const ERRO_INTERVALO = 'Intervalo invalido: fim deve ser posterior a inicio';
const ERRO_JANELA = 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00';
const ERRO_DURACAO = 'Duracao acima do limite: a politica permite no maximo 2 horas';
const MAXIMO_DE_ALTERNATIVAS = 3;

export function criarAgenda(dados: { salas: Sala[]; reservas: Reserva[]; versaoDaPolitica: () => string }): Agenda {
  const salas = dados.salas;
  const reservas = dados.reservas.map((r) => ({ ...r, ...normalizar(r) }));
  const agenda: Agenda = {
    listarSalas: () => salas,
    validarPedido(pedido) {
      if (!salas.some((s) => s.id === pedido.sala)) return { ok: false, erro: `Sala inexistente: ${pedido.sala}` };
      const inicio = lerInstante(pedido.inicio);
      if (inicio === undefined) return { ok: false, erro: `Data invalida: ${pedido.inicio}` };
      const fim = lerInstante(pedido.fim);
      if (fim === undefined) return { ok: false, erro: `Data invalida: ${pedido.fim}` };
      if (fim <= inicio) return { ok: false, erro: ERRO_INTERVALO };
      const meiaNoite = meiaNoiteEmSaoPaulo(inicio);
      if (inicio < meiaNoite + JANELA_ABRE_MS || fim > meiaNoite + JANELA_FECHA_MS) return { ok: false, erro: ERRO_JANELA };
      if (fim - inicio > DURACAO_MAXIMA_MS) return { ok: false, erro: ERRO_DURACAO };
      return { ok: true, sala: pedido.sala, intervalo: { inicio: emSaoPaulo(inicio), fim: emSaoPaulo(fim) } };
    },
    consultarConflitos(sala, intervalo) {
      const { inicio, fim } = instantes(intervalo);
      return reservas.filter((r) => {
        if (r.sala !== sala) return false;
        const outro = instantes(r);
        return outro.inicio < fim && inicio < outro.fim;
      });
    },
    alternativas(sala, intervalo) {
      const capacidade = salas.find((s) => s.id === sala)?.capacidade ?? Infinity;
      return salas
        .filter((s) => s.id !== sala && s.capacidade >= capacidade)
        .filter((s) => agenda.consultarConflitos(s.id, intervalo).length === 0)
        .sort((a, b) => a.capacidade - b.capacidade || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, MAXIMO_DE_ALTERNATIVAS)
        .map((s) => s.id);
    },
    reservar(sala, intervalo, responsavel) {
      const reserva = { id: proximoId(reservas), sala, ...normalizar(intervalo), responsavel };
      reservas.push(reserva);
      return reserva;
    },
    versaoDaPolitica: dados.versaoDaPolitica,
  };
  return agenda;
}

/** `res-NNNN` seguinte ao maior numero entre as Reservas existentes. */
function proximoId(reservas: Reserva[]): string {
  const maior = Math.max(0, ...reservas.map((r) => Number(/^res-(\d+)$/.exec(r.id)?.[1] ?? 0)));
  return `res-${String(maior + 1).padStart(4, '0')}`;
}

// --- Tempo -------------------------------------------------------------------
// Sao Paulo nao tem horario de verao desde 2019 e a Politica de uso fala em
// -03:00, entao o fuso e um offset fixo.

const OFFSET_SAO_PAULO_MS = -3 * HORA_MS;
const DIA_MS = 24 * HORA_MS;

/** Instante da meia-noite, em Sao Paulo, do dia em que `instante` cai. */
function meiaNoiteEmSaoPaulo(instante: number): number {
  return Math.floor((instante + OFFSET_SAO_PAULO_MS) / DIA_MS) * DIA_MS - OFFSET_SAO_PAULO_MS;
}

// Data e hora completas com offset obrigatorio (`Z` ou `+hh:mm`/`-hh:mm`).
const ISO_COM_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/** Instante (ms desde a epoca) de uma data ISO 8601 com offset, ou undefined se invalida. */
function lerInstante(valor: string): number | undefined {
  const m = ISO_COM_OFFSET.exec(valor);
  if (!m) return undefined;
  const [ano, mes, dia, hora, minuto, segundo] = m.slice(1, 7).map((p) => Number(p ?? 0));
  const fracaoMs = m[7] ? Math.floor(Number(m[7]) * 1000) : 0;
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasNoMes || hora > 23 || minuto > 59 || segundo > 59) return undefined;
  let offsetMin = 0;
  if (!m[8]) {
    const [oh, om] = [Number(m[10]), Number(m[11])];
    if (oh > 23 || om > 59) return undefined;
    offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, fracaoMs) - offsetMin * 60 * 1000;
}

/** Instantes de um Intervalo ja validado (normalizado ou nao). */
function instantes(intervalo: Intervalo): { inicio: number; fim: number } {
  const inicio = lerInstante(intervalo.inicio);
  const fim = lerInstante(intervalo.fim);
  if (inicio === undefined || fim === undefined) throw new Error(`Intervalo com data invalida: ${intervalo.inicio} / ${intervalo.fim}`);
  return { inicio, fim };
}

function normalizar(intervalo: Intervalo): Intervalo {
  const { inicio, fim } = instantes(intervalo);
  return { inicio: emSaoPaulo(inicio), fim: emSaoPaulo(fim) };
}

/** ISO 8601 no horario de Sao Paulo: `YYYY-MM-DDTHH:MM:SS-03:00` (fracao so quando houver). */
function emSaoPaulo(instante: number): string {
  const local = new Date(instante + OFFSET_SAO_PAULO_MS).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const fracao = instante % 1000 === 0 ? '' : local.slice(19, 23);
  return `${local.slice(0, 19)}${fracao}-03:00`;
}

/** Agenda nova com as Salas e Reservas da pasta de dados do starter. */
export function carregarAgenda(): Agenda {
  return criarAgenda({ salas: lerSalas(), reservas: lerReservas(), versaoDaPolitica: lerVersaoDaPolitica });
}
