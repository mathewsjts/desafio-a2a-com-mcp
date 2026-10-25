// Leitura dos arquivos de dados do starter (pasta `dados/` na raiz do repo).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PASTA_DADOS = fileURLToPath(new URL('../../dados/', import.meta.url));

export type Sala = { id: string; nome: string; capacidade: number; recursos: string[] };

export function lerSalas(): Sala[] {
  return JSON.parse(readFileSync(join(PASTA_DADOS, 'salas.json'), 'utf8')) as Sala[];
}
