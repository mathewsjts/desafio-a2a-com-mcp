// Leitura dos arquivos de dados do starter (pasta `dados/` na raiz do repo).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PASTA_DADOS = fileURLToPath(new URL('../../dados/', import.meta.url));

export type Sala = { id: string; nome: string; capacidade: number; recursos: string[] };

export function lerSalas(): Sala[] {
  return JSON.parse(readFileSync(join(PASTA_DADOS, 'salas.json'), 'utf8')) as Sala[];
}

export type Reserva = { id: string; sala: string; inicio: string; fim: string; responsavel: string };

export function lerReservas(): Reserva[] {
  return JSON.parse(readFileSync(join(PASTA_DADOS, 'reservas.json'), 'utf8')) as Reserva[];
}

export const ARQUIVO_POLITICA = join(PASTA_DADOS, 'politica-de-uso.md');

/** Versao da Politica de uso: a primeira linha do arquivo e `versao: <valor>`. Lida a cada chamada. */
export function lerVersaoDaPolitica(): string {
  const primeiraLinha = readFileSync(ARQUIVO_POLITICA, 'utf8').split('\n', 1)[0];
  const versao = /^versao:\s*(\S+)\s*$/.exec(primeiraLinha)?.[1];
  if (!versao) throw new Error(`Politica de uso sem versao na primeira linha: ${ARQUIVO_POLITICA}`);
  return versao;
}
