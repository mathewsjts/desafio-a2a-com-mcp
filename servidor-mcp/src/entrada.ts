// Ponto de entrada HTTP do servidor MCP: o unico caminho por onde um request
// chega ao SDK. Para cada POST em /mcp:
//   1. registra no stderr uma linha JSON com method, id e traceparent;
//   2. recusa com -32602 / HTTP 400 o request sem o envelope obrigatorio de
//      _meta (sem isso o SDK classificaria o caso "sem _meta e sem header" como
//      legado e responderia -32022);
//   3. entrega o resto ao handler do SDK.
// O guard de Host local do adaptador Node fica na frente de tudo.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  createMcpHandler,
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  TRACEPARENT_META_KEY,
  type McpServer,
} from '@modelcontextprotocol/server';
import { localhostHostValidation, toNodeHandler } from '@modelcontextprotocol/node';

export const CAMINHO_MCP = '/mcp';

type Objeto = Record<string, unknown>;

const ehObjeto = (v: unknown): v is Objeto => typeof v === 'object' && v !== null && !Array.isArray(v);

function lerCorpo(req: IncomingMessage): Promise<string> {
  return new Promise((ok, falha) => {
    const pedacos: Buffer[] = [];
    req.on('data', (p: Buffer) => pedacos.push(p));
    req.on('end', () => ok(Buffer.concat(pedacos).toString('utf8')));
    req.on('error', falha);
  });
}

function responderJson(res: ServerResponse, status: number, corpo: unknown): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto) });
  res.end(texto);
}

function erroJsonRpc(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function registrar(corpo: unknown): void {
  const params = ehObjeto(corpo) ? corpo.params : undefined;
  const meta = ehObjeto(params) ? params._meta : undefined;
  const linha = {
    method: ehObjeto(corpo) && typeof corpo.method === 'string' ? corpo.method : null,
    id: ehObjeto(corpo) && 'id' in corpo ? corpo.id : null,
    traceparent: ehObjeto(meta) && typeof meta[TRACEPARENT_META_KEY] === 'string' ? meta[TRACEPARENT_META_KEY] : null,
  };
  process.stderr.write(JSON.stringify(linha) + '\n');
}

/** Request (nao notificacao) sem protocolVersion ou sem clientCapabilities no _meta. */
function semEnvelope(corpo: unknown): boolean {
  if (!ehObjeto(corpo) || !('id' in corpo)) return false;
  const params = corpo.params;
  const meta = ehObjeto(params) ? params._meta : undefined;
  return !ehObjeto(meta) || meta[PROTOCOL_VERSION_META_KEY] === undefined || meta[CLIENT_CAPABILITIES_META_KEY] === undefined;
}

/** Monta o servidor HTTP. `fabrica` cria um McpServer novo por request. */
export function criarServidorHttp(fabrica: () => McpServer): Server {
  const handler = createMcpHandler(fabrica, { responseMode: 'json', legacy: 'reject' });
  const sdk = toNodeHandler(handler);
  const guardaDeHost = localhostHostValidation();

  return createServer(async (req, res) => {
    try {
      if (!guardaDeHost(req, res)) return;
      const caminho = (req.url ?? '').split('?')[0];
      if (caminho !== CAMINHO_MCP) {
        responderJson(res, 404, erroJsonRpc(null, -32601, `Not found: ${caminho}`));
        return;
      }
      if (req.method !== 'POST') {
        await sdk(req, res);
        return;
      }

      const bruto = await lerCorpo(req);
      let corpo: unknown;
      try {
        corpo = JSON.parse(bruto);
      } catch {
        registrar(undefined);
        responderJson(res, 400, erroJsonRpc(null, -32700, 'Parse error'));
        return;
      }
      registrar(corpo);

      if (semEnvelope(corpo)) {
        responderJson(
          res,
          400,
          erroJsonRpc(
            (corpo as Objeto).id,
            -32602,
            `Invalid params: _meta must carry ${PROTOCOL_VERSION_META_KEY} and ${CLIENT_CAPABILITIES_META_KEY}`,
          ),
        );
        return;
      }

      await sdk(req, res, corpo);
    } catch (e) {
      process.stderr.write(JSON.stringify({ erro: e instanceof Error ? e.message : String(e) }) + '\n');
      if (!res.headersSent) responderJson(res, 500, erroJsonRpc(null, -32603, 'Internal error'));
      else res.end();
    }
  });
}
