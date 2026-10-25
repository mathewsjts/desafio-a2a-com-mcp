// McpServer "Central de Salas": identidade, capabilities, tools e resources.
// Criado por request (o SDK chama a fabrica a cada POST), entao todo estado de
// dominio vive fora daqui.

import { McpServer, acceptedContent, inputRequired, inputResponse, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { carregarAgenda, type Reserva } from './agenda.ts';
import { criarCodecDeEstado, type Selado } from './estado.ts';
import { registrarPolitica } from './politica.ts';

const agenda = carregarAgenda();
const codec = criarCodecDeEstado();

/** Chave fixa da Escolha em `inputRequests`/`inputResponses`. */
const CHAVE_ESCOLHA = 'escolha_de_sala';
const MENSAGEM_ESCOLHA = 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.';
const ERRO_SEM_ALTERNATIVAS = 'Sem alternativas disponiveis no intervalo';

const SalaSchema = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});

/** Conteudo de uma Escolha aceita na elicitation. */
const EscolhaSchema = z.object({ sala: z.string() });

/** Resultado de sucesso: structuredContent e o mesmo JSON num bloco de texto. */
function resultado<T extends Record<string, unknown>>(dados: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(dados) }], structuredContent: dados };
}

/** Erro de dominio: isError com a mensagem exata no bloco de texto. */
function erroDeDominio(mensagem: string) {
  return { isError: true, content: [{ type: 'text' as const, text: mensagem }] };
}

/** Reserva concluida no formato de saida de `reservar_sala`. */
function reservaConcluida(reserva: Reserva, politica: string) {
  const { id, sala, inicio, fim, responsavel } = reserva;
  return resultado({ reserva: id, reservado: true, sala, inicio, fim, responsavel, politica, motivo: null });
}

/** Recusa: concluida sem Reserva, sem isError. */
function reservaRecusada() {
  return resultado({ reserva: null, reservado: false, sala: null, inicio: null, fim: null, responsavel: null, politica: null, motivo: 'recusado' });
}

/**
 * Pausa do MRTR: pede a Escolha entre as Alternativas e sela o Pedido junto
 * com elas no requestState. Sem Alternativas, e o erro de dominio. Sem efeito
 * colateral, porque o SDK ainda pode trocar esta resposta por -32021 se o
 * cliente nao declarou elicitation.
 */
async function pedirEscolha(selado: Selado, ctx: ServerContext) {
  if (selado.alternativas.length === 0) return erroDeDominio(ERRO_SEM_ALTERNATIVAS);
  return inputRequired({
    inputRequests: {
      [CHAVE_ESCOLHA]: inputRequired.elicit({
        message: MENSAGEM_ESCOLHA,
        requestedSchema: {
          type: 'object',
          properties: {
            sala: { type: 'string', title: 'Sala', description: 'Sala alternativa escolhida', enum: selado.alternativas },
          },
          required: ['sala'],
        },
      }),
    },
    requestState: await codec.mint(selado, ctx),
  });
}

/**
 * Retry do MRTR: o Pedido vem do payload selado (os arguments reenviados nao
 * contam) e a disponibilidade e revalidada antes de reservar.
 */
async function concluirEscolha(selado: Selado, ctx: ServerContext) {
  const resposta = inputResponse(ctx.mcpReq.inputResponses, CHAVE_ESCOLHA);
  if (resposta.kind === 'elicit' && resposta.action !== 'accept') return reservaRecusada();
  const intervalo = { inicio: selado.inicio, fim: selado.fim };
  const escolha = acceptedContent(ctx.mcpReq.inputResponses, CHAVE_ESCOLHA, EscolhaSchema)?.sala;
  if (escolha !== undefined && selado.alternativas.includes(escolha) && agenda.consultarConflitos(escolha, intervalo).length === 0) {
    const reserva = agenda.reservar(escolha, intervalo, selado.responsavel);
    return reservaConcluida(reserva, agenda.versaoDaPolitica());
  }
  // Escolha fora das Alternativas seladas, ja ocupada ou ausente: nova Pausa
  // com as Alternativas de agora.
  return pedirEscolha({ ...selado, alternativas: agenda.alternativas(selado.sala, intervalo) }, ctx);
}

export function criarServidorMcp(): McpServer {
  const servidor = new McpServer(
    { name: 'central-de-salas', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} }, requestState: { verify: codec.verify } },
  );

  servidor.registerTool(
    'listar_salas',
    {
      description: 'Lista todas as salas com capacidade e recursos.',
      outputSchema: z.object({ salas: z.array(SalaSchema) }),
    },
    async () => resultado({ salas: agenda.listarSalas() }),
  );

  servidor.registerTool(
    'consultar_disponibilidade',
    {
      description: 'Diz se uma sala esta livre num intervalo e, se nao estiver, quais reservas conflitam.',
      inputSchema: z.object({ sala: z.string(), inicio: z.string(), fim: z.string() }),
      outputSchema: z.object({
        sala: z.string(),
        livre: z.boolean(),
        conflitos: z.array(z.object({ id: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() })),
      }),
    },
    async (args) => {
      const validacao = agenda.validarPedido(args);
      if (!validacao.ok) return erroDeDominio(validacao.erro);
      const conflitos = agenda
        .consultarConflitos(validacao.sala, validacao.intervalo)
        .map(({ id, inicio, fim, responsavel }) => ({ id, inicio, fim, responsavel }));
      return resultado({ sala: validacao.sala, livre: conflitos.length === 0, conflitos });
    },
  );

  servidor.registerTool(
    'reservar_sala',
    {
      description: 'Reserva uma sala num intervalo, respeitando a politica de uso.',
      inputSchema: z.object({ sala: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() }),
      outputSchema: z.object({
        reserva: z.string().nullable().optional(),
        reservado: z.boolean().optional(),
        sala: z.string().nullable().optional(),
        inicio: z.string().nullable().optional(),
        fim: z.string().nullable().optional(),
        responsavel: z.string().nullable().optional(),
        politica: z.string().nullable().optional(),
        motivo: z.string().nullable().optional(),
      }),
    },
    async (args, ctx) => {
      const selado = ctx.mcpReq.requestState<Selado>();
      if (selado) return concluirEscolha(selado, ctx);
      const validacao = agenda.validarPedido(args);
      if (!validacao.ok) return erroDeDominio(validacao.erro);
      if (agenda.consultarConflitos(validacao.sala, validacao.intervalo).length > 0) {
        const alternativas = agenda.alternativas(validacao.sala, validacao.intervalo);
        return pedirEscolha({ sala: validacao.sala, ...validacao.intervalo, responsavel: args.responsavel, alternativas }, ctx);
      }
      const reserva = agenda.reservar(validacao.sala, validacao.intervalo, args.responsavel);
      return reservaConcluida(reserva, agenda.versaoDaPolitica());
    },
  );

  registrarPolitica(servidor);

  return servidor;
}
