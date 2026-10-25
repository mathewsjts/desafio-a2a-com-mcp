// Harness do Ponto A: sobe os processos como filhos em portas de teste, fala
// com eles apenas por HTTP e le o stderr de cada um. Nada aqui importa codigo
// do servidor MCP nem do agente.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOLO = '2026-07-28';
export const CAPABILITIES_COM_ELICITATION = { elicitation: { form: {} } };

/** Segredo de teste com 64 bytes. Gerado por execucao, nunca gravado. */
export const SEGREDO_DE_TESTE = randomBytes(32).toString('hex');

export type Saida = { codigo: number | null; sinal: NodeJS.Signals | null };

export type Processo = {
  readonly nome: string;
  readonly porta: number;
  readonly url: string;
  readonly filho: ChildProcess;
  /** Todas as linhas de stderr ate agora, na ordem. */
  linhas(): string[];
  /** Linhas de stderr que sao objetos JSON. As demais sao ignoradas. */
  logs(): Record<string, unknown>[];
  /** Espera ate existir uma linha JSON que satisfaca o predicado. */
  esperarLog(pred: (l: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Resolve quando o processo termina. */
  readonly saida: Promise<Saida>;
  parar(): Promise<Saida>;
};

/** Porta livre do sistema operacional. */
export async function portaLivre(): Promise<number> {
  return new Promise((ok, falha) => {
    const s = createServer();
    s.unref();
    s.on('error', falha);
    s.listen(0, '127.0.0.1', () => {
      const endereco = s.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      s.close(() => ok(porta));
    });
  });
}

function aceitaConexao(porta: number): Promise<boolean> {
  return new Promise((ok) => {
    const sock = connect(porta, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); ok(true); });
    sock.once('error', () => { sock.destroy(); ok(false); });
  });
}

const espera = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export type OpcoesProcesso = {
  nome: string;
  /** Script TypeScript relativo a raiz do repo. */
  script: string;
  porta: number;
  env?: Record<string, string | undefined>;
  /** Se false, nao espera a porta abrir (para testar falha na subida). */
  esperarPorta?: boolean;
  timeoutMs?: number;
};

/**
 * Sobe `node --import tsx <script>` como filho, com o ambiente dado
 * (sobrepondo o do processo de teste) e espera a porta aceitar conexoes.
 */
export async function iniciarProcesso(op: OpcoesProcesso): Promise<Processo> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...op.env })) if (v !== undefined) env[k] = v;
  const filho = spawn(process.execPath, ['--import', 'tsx', op.script], {
    cwd: RAIZ,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const linhas: string[] = [];
  let resto = '';
  filho.stderr!.setEncoding('utf8');
  filho.stderr!.on('data', (pedaco: string) => {
    resto += pedaco;
    const partes = resto.split('\n');
    resto = partes.pop() ?? '';
    linhas.push(...partes);
  });

  let terminou = false;
  const saida = new Promise<Saida>((ok) => {
    filho.once('exit', (codigo, sinal) => {
      terminou = true;
      if (resto) { linhas.push(resto); resto = ''; }
      ok({ codigo, sinal });
    });
  });

  const logs = () => {
    const out: Record<string, unknown>[] = [];
    for (const l of linhas) {
      try {
        const v = JSON.parse(l);
        if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
      } catch { /* linha que nao e JSON (avisos do SDK etc.) */ }
    }
    return out;
  };

  const proc: Processo = {
    nome: op.nome,
    porta: op.porta,
    url: `http://127.0.0.1:${op.porta}`,
    filho,
    linhas: () => [...linhas],
    logs,
    async esperarLog(pred, timeoutMs = 3000) {
      const limite = Date.now() + timeoutMs;
      for (;;) {
        const achado = logs().find(pred);
        if (achado) return achado;
        if (Date.now() > limite) {
          throw new Error(`${op.nome}: nenhuma linha de log esperada em ${timeoutMs} ms. stderr:\n${linhas.join('\n')}`);
        }
        await espera(20);
      }
    },
    saida,
    async parar() {
      if (!terminou) filho.kill('SIGTERM');
      return saida;
    },
  };

  if (op.esperarPorta === false) return proc;

  const limite = Date.now() + (op.timeoutMs ?? 15000);
  for (;;) {
    if (terminou) {
      throw new Error(`${op.nome} terminou antes de abrir a porta ${op.porta}. stderr:\n${linhas.join('\n')}`);
    }
    if (await aceitaConexao(op.porta)) return proc;
    if (Date.now() > limite) {
      await proc.parar();
      throw new Error(`${op.nome} nao abriu a porta ${op.porta}. stderr:\n${linhas.join('\n')}`);
    }
    await espera(50);
  }
}

/** Sobe o servidor MCP numa porta de teste, com o segredo de teste. */
export async function iniciarServidorMcp(
  op: { porta?: number; env?: Record<string, string | undefined>; esperarPorta?: boolean } = {},
): Promise<Processo> {
  const porta = op.porta ?? (await portaLivre());
  return iniciarProcesso({
    nome: 'servidor-mcp',
    script: 'servidor-mcp/src/main.ts',
    porta,
    env: { MCP_PORT: String(porta), REQUEST_STATE_SECRET: SEGREDO_DE_TESTE, ...op.env },
    esperarPorta: op.esperarPorta,
  });
}

/**
 * Sobe o agente numa porta de teste, apontando para o servidor MCP em `mcpUrl`
 * (ex.: `${srv.url}/mcp`). Sem `mcpUrl`, o agente usa o padrao dele.
 */
export async function iniciarAgente(
  op: { porta?: number; mcpUrl?: string; env?: Record<string, string | undefined>; esperarPorta?: boolean } = {},
): Promise<Processo> {
  const porta = op.porta ?? (await portaLivre());
  return iniciarProcesso({
    nome: 'agente',
    script: 'agente/src/main.ts',
    porta,
    env: {
      AGENT_PORT: String(porta),
      AGENT_CARD_URL: `http://127.0.0.1:${porta}/a2a`,
      MCP_URL: op.mcpUrl,
      ...op.env,
    },
    esperarPorta: op.esperarPorta,
  });
}

// ---------------------------------------------------------------- HTTP cru

export type RespostaHttp = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bruto: string;
  /** Corpo como JSON, ou undefined se nao for JSON. */
  corpo: any;
};

/**
 * POST (ou outro metodo) cru com `node:http`, que permite qualquer header,
 * inclusive `Host` (o `fetch` nao deixa trocar o Host).
 */
export function http(
  url: string,
  op: { metodo?: string; headers?: Record<string, string>; corpo?: string } = {},
): Promise<RespostaHttp> {
  return new Promise((ok, falha) => {
    const req = httpRequest(url, { method: op.metodo ?? 'POST', headers: op.headers }, (res) => {
      const pedacos: Buffer[] = [];
      res.on('data', (p: Buffer) => pedacos.push(p));
      res.on('end', () => {
        const bruto = Buffer.concat(pedacos).toString('utf8');
        let corpo: any;
        try { corpo = JSON.parse(bruto); } catch { corpo = undefined; }
        ok({ status: res.statusCode ?? 0, headers: res.headers, bruto, corpo });
      });
    });
    req.on('error', falha);
    if (op.corpo !== undefined) req.write(op.corpo);
    req.end();
  });
}

/** POST de um corpo JSON-RPC qualquer. */
export function postJson(url: string, corpo: unknown, headers: Record<string, string> = {}): Promise<RespostaHttp> {
  return http(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    corpo: JSON.stringify(corpo),
  });
}

let proximoId = 1;

export type OpcoesMcp = {
  /** `Mcp-Name` (nome da tool ou URI do resource). Por padrao, `params.name` ou `params.uri`. */
  nome?: string;
  capabilities?: unknown;
  traceparent?: string;
  /** Remove uma chave do envelope de `_meta`. */
  omitir?: 'protocolVersion' | 'clientCapabilities';
  /** Envia o request sem nenhum `_meta` e sem o header `MCP-Protocol-Version`. */
  semMeta?: boolean;
  id?: string | number;
  headers?: Record<string, string>;
};

/**
 * Request MCP cru, no formato do validador: envelope em `_meta` e headers
 * `MCP-Protocol-Version`, `Mcp-Method` e `Mcp-Name` espelhados do corpo.
 */
export function mcp(url: string, metodo: string, params: Record<string, unknown> = {}, op: OpcoesMcp = {}): Promise<RespostaHttp> {
  const id = op.id ?? proximoId++;
  const headers: Record<string, string> = { 'Mcp-Method': metodo };
  const nome = op.nome ?? (typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined);
  if (nome) headers['Mcp-Name'] = nome;

  let corpoParams: Record<string, unknown> = params;
  if (!op.semMeta) {
    headers['MCP-Protocol-Version'] = PROTOCOLO;
    const meta: Record<string, unknown> = {
      'io.modelcontextprotocol/protocolVersion': PROTOCOLO,
      'io.modelcontextprotocol/clientCapabilities': op.capabilities ?? CAPABILITIES_COM_ELICITATION,
    };
    if (op.traceparent) meta.traceparent = op.traceparent;
    if (op.omitir) delete meta[`io.modelcontextprotocol/${op.omitir}`];
    corpoParams = { ...params, _meta: meta };
  }
  return postJson(url, { jsonrpc: '2.0', id, method: metodo, params: corpoParams }, { ...headers, ...op.headers });
}

/** Texto concatenado dos blocos `content` de um resultado de tool. */
export function textoDe(resultado: any): string {
  return ((resultado?.content ?? []) as any[]).map((c) => c?.text ?? '').join(' ');
}

/** traceparent W3C novo, com trace-id e span-id aleatorios. */
export function novoTraceparent(traceId = randomBytes(16).toString('hex')): string {
  return `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
}

// ---------------------------------------------------------------- A2A

let proximoIdA2a = 1;

export type OpcoesA2a = {
  /** Header `traceparent` do request A2A. */
  traceparent?: string;
  id?: string | number;
  headers?: Record<string, string>;
};

/** Request JSON-RPC 2.0 cru ao endpoint A2A do agente (ex.: `${agente.url}/a2a`). */
export function a2a(url: string, metodo: string, params: unknown, op: OpcoesA2a = {}): Promise<RespostaHttp> {
  const headers: Record<string, string> = { ...op.headers };
  if (op.traceparent) headers.traceparent = op.traceparent;
  return postJson(url, { jsonrpc: '2.0', id: op.id ?? proximoIdA2a++, method: metodo, params }, headers);
}

/**
 * `SendMessage` com uma mensagem de usuario de texto. Com `taskId`, continua
 * essa Task; sem ele, abre uma Task nova.
 */
export function enviarMensagem(
  url: string,
  texto: string,
  op: OpcoesA2a & { taskId?: string; messageId?: string } = {},
): Promise<RespostaHttp> {
  const message: Record<string, unknown> = {
    messageId: op.messageId ?? `msg-${randomBytes(6).toString('hex')}`,
    role: 'ROLE_USER',
    parts: [{ text: texto }],
  };
  if (op.taskId) message.taskId = op.taskId;
  return a2a(url, 'SendMessage', { message }, op);
}

/** `GetTask` por id. */
export function obterTask(url: string, id: string, op: OpcoesA2a = {}): Promise<RespostaHttp> {
  return a2a(url, 'GetTask', { id }, op);
}

/** A Task de uma resposta `{ result: { task } }` (undefined se nao houver). */
export function taskDe(resposta: RespostaHttp): any {
  return resposta.corpo?.result?.task;
}

/** Texto concatenado das parts de uma mensagem A2A. */
export function textoDaMensagem(mensagem: any): string {
  return ((mensagem?.parts ?? []) as any[]).map((p) => p?.text ?? '').join(' ');
}

/** trace-id (32 hex) de um traceparent W3C, ou undefined. */
export function traceIdDe(traceparent: unknown): string | undefined {
  return typeof traceparent === 'string' ? /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent)?.[1] : undefined;
}

// ---------------------------------------------------------------- espiao MCP

/** Um POST que passou pelo espiao: corpos crus e ja interpretados como JSON. */
export type Troca = { bruto: string; pedido: any; brutoDaResposta: string; resposta: any };

export type EspiaoMcp = {
  /** Base do espiao: o agente usa `${espiao.url}/mcp` no lugar de `${srv.url}/mcp`. */
  readonly url: string;
  /** As trocas ate agora, na ordem em que as respostas voltaram. */
  trocas(): Troca[];
  parar(): Promise<void>;
};

/**
 * Proxy HTTP entre o agente e o servidor MCP em `destino` (ex.: `srv.url`).
 * Repassa cada request sem alteracao e guarda os corpos dos dois lados, para o
 * teste ver o que o agente mandou de fato (argumentos, inputResponses,
 * requestState) sem olhar dentro do agente.
 */
export async function iniciarEspiaoMcp(destino: string): Promise<EspiaoMcp> {
  const trocas: Troca[] = [];
  const json = (bruto: string) => { try { return JSON.parse(bruto); } catch { return undefined; } };
  const servidor = createHttpServer((req, res) => {
    const pedacos: Buffer[] = [];
    req.on('data', (p: Buffer) => pedacos.push(p));
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos).toString('utf8');
      const repasse = httpRequest(new URL(req.url ?? '/', destino), { method: req.method, headers: req.headers }, (r) => {
        const volta: Buffer[] = [];
        r.on('data', (p: Buffer) => volta.push(p));
        r.on('end', () => {
          const corpo = Buffer.concat(volta);
          const brutoDaResposta = corpo.toString('utf8');
          trocas.push({ bruto, pedido: json(bruto), brutoDaResposta, resposta: json(brutoDaResposta) });
          const headers = { ...r.headers };
          delete headers['transfer-encoding'];
          delete headers.connection;
          headers['content-length'] = String(corpo.length);
          res.writeHead(r.statusCode ?? 502, headers);
          res.end(corpo);
        });
      });
      repasse.on('error', () => { res.writeHead(502); res.end(); });
      repasse.end(bruto);
    });
  });
  const porta = await portaLivre();
  await new Promise<void>((ok) => servidor.listen(porta, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${porta}`,
    trocas: () => [...trocas],
    parar: () => new Promise<void>((ok) => { servidor.closeAllConnections(); servidor.close(() => ok()); }),
  };
}
