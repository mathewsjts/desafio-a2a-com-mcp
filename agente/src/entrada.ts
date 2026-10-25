// Ponto de entrada HTTP do agente (ADR 0001: A2A v1.0 escrito a mao, sem SDK).
//   GET  /.well-known/agent-card.json -> Agent Card
//   POST /a2a                         -> JSON-RPC 2.0: SendMessage e GetTask
// Toda resposta JSON-RPC sai com HTTP 200; erros vao no campo `error`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Conducao } from './conducao.ts';
import { ehTerminal, paraWire, type Mensagem, type StoreDeTasks } from './task.ts';
import { traceIdDoHeader } from './trace.ts';

export const CAMINHO_CARD = '/.well-known/agent-card.json';
export const CAMINHO_A2A = '/a2a';

/** Erro JSON-RPC com codigo, levado ate a resposta. */
export class ErroA2a extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

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

const erroJsonRpc = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** A mensagem do usuario em `params.message`, ja na forma do historico. */
function lerMensagem(params: unknown): Mensagem {
  const m = ehObjeto(params) ? params.message : undefined;
  if (!ehObjeto(m) || typeof m.messageId !== 'string' || m.role !== 'ROLE_USER' || !Array.isArray(m.parts)) {
    throw new ErroA2a(-32602, 'Invalid params: message precisa de messageId, role ROLE_USER e parts');
  }
  const parts = m.parts.filter((p): p is { text: string } => ehObjeto(p) && typeof p.text === 'string').map((p) => ({ text: p.text }));
  if (parts.length === 0) throw new ErroA2a(-32602, 'Invalid params: message precisa de ao menos uma part de texto');
  const mensagem: Mensagem = { messageId: m.messageId, role: 'ROLE_USER', parts };
  if (typeof m.taskId === 'string') mensagem.taskId = m.taskId;
  if (typeof m.contextId === 'string') mensagem.contextId = m.contextId;
  return mensagem;
}

export type OpcoesEntrada = {
  card: unknown;
  tasks: StoreDeTasks;
  conducao: Conducao;
};

export function criarServidorHttp(op: OpcoesEntrada): Server {
  const { tasks, conducao } = op;

  function obterTask(id: string) {
    const task = tasks.obter(id);
    if (!task) throw new ErroA2a(-32001, `Task not found: ${id}`);
    return task;
  }

  const metodos: Record<string, (params: unknown, req: IncomingMessage) => Promise<unknown>> = {
    async SendMessage(params, req) {
      const mensagem = lerMensagem(params);
      const texto = mensagem.parts.map((p) => p.text).join(' ');
      if (mensagem.taskId !== undefined) {
        // Mensagem para uma Task existente. Terminal nunca volta a WORKING, e a
        // Task nao muda. Fora disso, so a Pausa espera o cliente: a ponte.
        const task = obterTask(mensagem.taskId);
        if (ehTerminal(task.estado)) throw new ErroA2a(-32004, `Task ${task.id} esta em estado terminal (${task.estado})`);
        if (task.estado !== 'TASK_STATE_INPUT_REQUIRED') {
          throw new ErroA2a(-32004, `Task ${task.id} nao espera resposta do cliente (${task.estado})`);
        }
        await conducao.continuar(task, mensagem, texto);
        return { task: paraWire(task) };
      }
      const task = tasks.abrir(mensagem, traceIdDoHeader(req.headers.traceparent));
      await conducao.executarPedido(task, texto);
      return { task: paraWire(task) };
    },

    async GetTask(params) {
      if (!ehObjeto(params) || typeof params.id !== 'string') throw new ErroA2a(-32602, 'Invalid params: id da Task ausente');
      return { task: paraWire(obterTask(params.id)) };
    },
  };

  async function atenderJsonRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let corpo: unknown;
    try {
      corpo = JSON.parse(await lerCorpo(req));
    } catch {
      responderJson(res, 200, erroJsonRpc(null, -32700, 'Parse error'));
      return;
    }
    if (!ehObjeto(corpo) || corpo.jsonrpc !== '2.0' || typeof corpo.method !== 'string') {
      responderJson(res, 200, erroJsonRpc(ehObjeto(corpo) ? corpo.id : null, -32600, 'Invalid Request'));
      return;
    }
    const { id, method } = corpo;
    const metodo = Object.hasOwn(metodos, method) ? metodos[method] : undefined;
    if (!metodo) {
      responderJson(res, 200, erroJsonRpc(id, -32601, `Method not found: ${method}`));
      return;
    }
    try {
      responderJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result: await metodo(corpo.params, req) });
    } catch (e) {
      if (e instanceof ErroA2a) {
        responderJson(res, 200, erroJsonRpc(id, e.code, e.message));
        return;
      }
      throw e;
    }
  }

  return createServer(async (req, res) => {
    try {
      const caminho = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && caminho === CAMINHO_CARD) {
        responderJson(res, 200, op.card);
        return;
      }
      if (req.method === 'POST' && caminho === CAMINHO_A2A) {
        await atenderJsonRpc(req, res);
        return;
      }
      responderJson(res, 404, erroJsonRpc(null, -32601, `Not found: ${req.method} ${caminho}`));
    } catch (e) {
      process.stderr.write(JSON.stringify({ erro: e instanceof Error ? e.message : String(e) }) + '\n');
      if (!res.headersSent) responderJson(res, 500, erroJsonRpc(null, -32603, 'Internal error'));
      else res.end();
    }
  });
}
