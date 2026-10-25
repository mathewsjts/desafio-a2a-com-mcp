// McpServer "Central de Salas": identidade, capabilities, tools e resources.
// Criado por request (o SDK chama a fabrica a cada POST), entao todo estado de
// dominio vive fora daqui.

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { carregarAgenda, type Reserva } from './agenda.ts';
import { registrarPolitica } from './politica.ts';

const agenda = carregarAgenda();

const SalaSchema = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});

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

export function criarServidorMcp(): McpServer {
  const servidor = new McpServer(
    { name: 'central-de-salas', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
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
    async (args) => {
      const validacao = agenda.validarPedido(args);
      if (!validacao.ok) return erroDeDominio(validacao.erro);
      const conflitos = agenda.consultarConflitos(validacao.sala, validacao.intervalo);
      // Provisorio: a fatia 05 troca este erro pela Escolha entre Alternativas (MRTR).
      if (conflitos.length > 0) return erroDeDominio(`Conflito com ${conflitos.map((c) => c.id).join(', ')}`);
      const reserva = agenda.reservar(validacao.sala, validacao.intervalo, args.responsavel);
      return reservaConcluida(reserva, agenda.versaoDaPolitica());
    },
  );

  registrarPolitica(servidor);

  return servidor;
}
