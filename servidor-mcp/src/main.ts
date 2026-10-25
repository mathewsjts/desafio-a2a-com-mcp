import { criarServidorHttp, CAMINHO_MCP } from './entrada.ts';
import { lerConfiguracaoDeEstado } from './estado.ts';

const PORTA = Number(process.env.MCP_PORT ?? 7301);

// Sem segredo forte nao ha requestState confiavel: recusa subir, com o motivo.
// Checa antes de importar servidor.ts, que monta o codec no carregamento.
try {
  lerConfiguracaoDeEstado();
} catch (erro) {
  process.stderr.write(`servidor MCP nao subiu: ${(erro as Error).message}\n`);
  process.exit(1);
}
const { criarServidorMcp } = await import('./servidor.ts');

const http = criarServidorHttp(criarServidorMcp);
http.listen(PORTA, '127.0.0.1', () => {
  process.stderr.write(`servidor MCP central-de-salas em http://127.0.0.1:${PORTA}${CAMINHO_MCP}\n`);
});

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, () => {
    http.close();
    http.closeAllConnections();
    process.exit(0);
  });
}
