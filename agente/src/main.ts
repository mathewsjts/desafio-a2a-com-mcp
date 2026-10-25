// Placeholder do agente "Central de Salas": so abre a porta e responde 501.
// O card, o SendMessage/GetTask e o host MCP chegam nas fatias 07 a 09.

import { createServer } from 'node:http';

const PORTA = Number(process.env.AGENT_PORT ?? 7300);

const http = createServer((_req, res) => {
  const corpo = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'agente ainda nao implementado' } });
  res.writeHead(501, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo) });
  res.end(corpo);
});

http.listen(PORTA, '127.0.0.1', () => {
  process.stderr.write(`agente (placeholder) em http://127.0.0.1:${PORTA}\n`);
});

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, () => {
    http.close();
    http.closeAllConnections();
    process.exit(0);
  });
}
