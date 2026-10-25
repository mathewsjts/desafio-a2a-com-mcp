import { criarServidorHttp, CAMINHO_MCP } from './entrada.ts';
import { criarServidorMcp } from './servidor.ts';

const PORTA = Number(process.env.MCP_PORT ?? 7301);

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
