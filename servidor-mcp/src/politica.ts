// Resource `politica://uso`: a Politica de uso do starter, entregue sem alteracao.
// O arquivo e lido a cada leitura, para que uma nova versao apareca sem reiniciar.

import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/server';
import { ARQUIVO_POLITICA } from './dados.ts';

export const URI_POLITICA = 'politica://uso';

export function registrarPolitica(servidor: McpServer): void {
  servidor.registerResource(
    'politica-de-uso',
    URI_POLITICA,
    { mimeType: 'text/markdown', description: 'Politica de uso das salas; a versao esta na primeira linha.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readFile(ARQUIVO_POLITICA, 'utf8') }],
    }),
  );
}
