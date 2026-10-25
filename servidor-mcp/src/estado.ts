// requestState do MRTR em reservar_sala: o unico lugar que monta o codec.
// HMAC-SHA256 do SDK, so assinado (o cliente consegue ler o payload, nao
// alterar). Nada fica guardado no servidor entre as rodadas.

import { createRequestStateCodec, type RequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';

/** O que viaja selado entre a Pausa e o retry: o Pedido normalizado e as Alternativas oferecidas. */
export type Selado = {
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
  alternativas: string[];
};

/** Validade de um requestState: dez minutos. */
const TTL_PADRAO_SEGUNDOS = 600;

/** Tamanho minimo da chave HMAC, em bytes (o mesmo piso do SDK). */
const BYTES_MINIMOS_DO_SEGREDO = 32;

export type ConfiguracaoDeEstado = { segredo: string; ttlSegundos: number };

/**
 * Le e valida a configuracao do requestState no ambiente:
 * `REQUEST_STATE_SECRET` (obrigatorio, >= 32 bytes) e
 * `REQUEST_STATE_TTL_SECONDS` (opcional, inteiro >= 0, padrao 600; existe para
 * os testes encurtarem a validade). Lanca `Error` com o motivo legivel.
 */
export function lerConfiguracaoDeEstado(env: NodeJS.ProcessEnv = process.env): ConfiguracaoDeEstado {
  const segredo = env.REQUEST_STATE_SECRET;
  if (!segredo) throw new Error('REQUEST_STATE_SECRET ausente');
  const bytes = Buffer.byteLength(segredo, 'utf8');
  if (bytes < BYTES_MINIMOS_DO_SEGREDO) {
    throw new Error(`REQUEST_STATE_SECRET fraco: ${bytes} bytes, o minimo e ${BYTES_MINIMOS_DO_SEGREDO}`);
  }
  const ttl = env.REQUEST_STATE_TTL_SECONDS;
  if (ttl === undefined || ttl === '') return { segredo, ttlSegundos: TTL_PADRAO_SEGUNDOS };
  const ttlSegundos = Number(ttl);
  if (!Number.isInteger(ttlSegundos) || ttlSegundos < 0) {
    throw new Error(`REQUEST_STATE_TTL_SECONDS invalido: ${ttl} (use um inteiro >= 0)`);
  }
  return { segredo, ttlSegundos };
}

/**
 * Amarra o estado ao metodo e a tool: um requestState emitido por
 * `reservar_sala` nao passa em outra tool nem em `resources/read`. O
 * `ServerContext` nao traz os params, entao a tool vem do header `Mcp-Name`,
 * que o SDK ja exige igual a `params.name` antes de despachar.
 */
function amarracao(ctx: ServerContext): string {
  return `${ctx.mcpReq.method}\0${ctx.http?.req?.headers.get('mcp-name') ?? ''}`;
}

/** Codec do requestState, com a configuracao de `lerConfiguracaoDeEstado`. */
export function criarCodecDeEstado(env: NodeJS.ProcessEnv = process.env): RequestStateCodec<Selado> {
  const { segredo, ttlSegundos } = lerConfiguracaoDeEstado(env);
  return createRequestStateCodec<Selado>({ key: segredo, ttlSeconds: ttlSegundos, bind: amarracao });
}
