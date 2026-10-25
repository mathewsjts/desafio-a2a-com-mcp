import { criarAgentCard } from './card.ts';
import { criarConducao } from './conducao.ts';
import { CAMINHO_A2A, criarServidorHttp } from './entrada.ts';
import { conectarHostMcp } from './host-mcp.ts';
import { criarStoreDeTasks } from './task.ts';

const PORTA = Number(process.env.AGENT_PORT ?? 7300);
const URL_CARD = process.env.AGENT_CARD_URL ?? `http://127.0.0.1:${PORTA}${CAMINHO_A2A}`;
const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:7301/mcp';

const host = await conectarHostMcp(URL_MCP);
const http = criarServidorHttp({
  card: criarAgentCard(URL_CARD),
  tasks: criarStoreDeTasks(),
  conducao: criarConducao(host),
});
http.listen(PORTA, '127.0.0.1', () => {
  process.stderr.write(`agente central-de-salas em http://127.0.0.1:${PORTA}${CAMINHO_A2A} (MCP em ${URL_MCP})\n`);
});

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, () => {
    http.close();
    http.closeAllConnections();
    process.exit(0);
  });
}
