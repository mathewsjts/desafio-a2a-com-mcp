// requestState do MRTR em reservar_sala: o unico lugar que monta o codec.
// HMAC-SHA256 do SDK, so assinado (o cliente consegue ler o payload, nao
// alterar). Nada fica guardado no servidor entre as rodadas.

import { createRequestStateCodec, type RequestStateCodec } from '@modelcontextprotocol/server';

/** O que viaja selado entre a Pausa e o retry: o Pedido normalizado e as Alternativas oferecidas. */
export type Selado = {
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
  alternativas: string[];
};

/** Validade de um requestState: dez minutos. */
export const TTL_PADRAO_SEGUNDOS = 600;

/**
 * Codec do requestState, com a chave de `REQUEST_STATE_SECRET`. O SDK recusa
 * chaves com menos de 32 bytes (RangeError).
 */
export function criarCodecDeEstado(env: NodeJS.ProcessEnv = process.env): RequestStateCodec<Selado> {
  const segredo = env.REQUEST_STATE_SECRET;
  if (!segredo) throw new Error('REQUEST_STATE_SECRET ausente');
  return createRequestStateCodec<Selado>({ key: segredo, ttlSeconds: TTL_PADRAO_SEGUNDOS });
}
