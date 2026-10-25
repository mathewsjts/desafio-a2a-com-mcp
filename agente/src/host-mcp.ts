// O agente como host MCP: uma unica instancia de Client do SDK, viva durante
// todo o processo, fixada no protocolo 2026-07-28. Toda chamada passa por
// `client.request` (nunca `callTool`, que quebra com input_required quando a
// tool declara outputSchema), com `_meta.traceparent` no trace-id da Task e um
// span-id novo. O SDK monta o envelope de `_meta`, os headers espelhados e um
// id de JSON-RPC novo por request.

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type DiscoverResult,
  type InputRequiredResult,
} from '@modelcontextprotocol/client';
import { novoTraceparent as traceparent } from './trace.ts';

export const PROTOCOLO_MCP = '2026-07-28';
export const TOOL_RESERVAR = 'reservar_sala';
export const URI_POLITICA = 'politica://uso';

/** Resultado cru do `tools/call`: `complete` (CallToolResult) ou `input_required`. */
export type ResultadoTool = CallToolResult | InputRequiredResult;

/** Rodada de retry MRTR (ticket 09): o que vai junto dos argumentos originais. */
export type Retry = {
  inputResponses: Record<string, unknown>;
  /** Ecoado byte a byte; o agente nunca o decodifica. */
  requestState: string;
};

export type HostMcp = {
  /** `tools/list`. Lanca se `reservar_sala` nao estiver entre as tools. */
  descobrirTools(traceId: string): Promise<void>;
  /** `resources/read politica://uso`, devolvendo a versao da primeira linha. */
  lerVersaoDaPolitica(traceId: string): Promise<string>;
  /** `tools/call reservar_sala` (com `retry`, a rodada seguinte do MRTR). */
  reservarSala(argumentos: Record<string, unknown>, traceId: string, retry?: Retry): Promise<ResultadoTool>;
};

/** O que o agente sabe do servidor sem perguntar: dispensa o `server/discover` na conexao. */
const DESCOBERTA_PREVIA: DiscoverResult = {
  supportedVersions: [PROTOCOLO_MCP],
  capabilities: { tools: {}, resources: {} },
};

export async function conectarHostMcp(url: string): Promise<HostMcp> {
  const client = new Client(
    { name: 'agente-central-de-salas', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: PROTOCOLO_MCP } },
      inputRequired: { autoFulfill: false },
    },
  );
  // Com `prior`, a conexao nao toca a rede: o agente sobe mesmo com o servidor
  // MCP fora do ar, e a mesma instancia sobrevive a reinicios dele (HTTP stateless).
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), {
    prior: { kind: 'modern', discover: DESCOBERTA_PREVIA },
  });

  return {
    async descobrirTools(traceId) {
      const r = await client.request({ method: 'tools/list', params: { _meta: { traceparent: traceparent(traceId) } } });
      if (!r.tools.some((t) => t.name === TOOL_RESERVAR)) {
        throw new Error(`Tool ${TOOL_RESERVAR} ausente no servidor MCP`);
      }
    },

    async lerVersaoDaPolitica(traceId) {
      const r = await client.request({
        method: 'resources/read',
        params: { uri: URI_POLITICA, _meta: { traceparent: traceparent(traceId) } },
      });
      const conteudo = r.contents[0];
      const texto = conteudo && 'text' in conteudo ? conteudo.text : '';
      const versao = /^versao:\s*(\S+)/.exec(texto.split('\n', 1)[0] ?? '')?.[1];
      if (!versao) throw new Error(`Versao ausente na primeira linha de ${URI_POLITICA}`);
      return versao;
    },

    async reservarSala(argumentos, traceId, retry) {
      const r = await client.request(
        {
          method: 'tools/call',
          params: { name: TOOL_RESERVAR, arguments: argumentos, ...retry, _meta: { traceparent: traceparent(traceId) } },
        },
        { allowInputRequired: true },
      );
      return r as ResultadoTool;
    },
  };
}
