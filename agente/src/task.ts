// Task A2A: maquina de estados explicita e store em memoria.
//
// A maquina de estados e a tabela TRANSICOES abaixo; toda mudanca de estado
// passa por `mover`, que recusa qualquer transicao fora dela. O store guarda,
// alem do que vai para o wire, o trace-id da Task e (so durante a Pausa) a
// continuacao MCP pendente, que nunca e serializada.

import { randomBytes } from 'node:crypto';

export type EstadoTask =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED';

/**
 * Transicoes permitidas (spec, "Maquina de estados"). Terminais nao tem saida.
 * A Recusa (INPUT_REQUIRED -> CANCELED "depois do retry com decline") passa
 * por WORKING durante o retry, como a Escolha: assim a Task nunca aceita duas
 * continuacoes ao mesmo tempo, e uma falha do MCP no retry ainda vira FAILED.
 */
const TRANSICOES: Readonly<Record<EstadoTask, readonly EstadoTask[]>> = {
  TASK_STATE_SUBMITTED: ['TASK_STATE_WORKING'],
  TASK_STATE_WORKING: ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_CANCELED'],
  TASK_STATE_INPUT_REQUIRED: ['TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_CANCELED'],
  TASK_STATE_COMPLETED: [],
  TASK_STATE_FAILED: [],
  TASK_STATE_CANCELED: [],
};

export function ehTerminal(estado: EstadoTask): boolean {
  return TRANSICOES[estado].length === 0;
}

export type Part = { text: string };

export type Mensagem = {
  messageId: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: Part[];
  taskId?: string;
  contextId?: string;
};

export type Artifact = { artifactId: string; name: string; parts: Part[] };

/**
 * Estado MCP pendente de uma Pausa (preenchido pela ponte, ticket 09).
 * Fica so no store: `paraWire` nunca o inclui.
 */
export type Continuacao = {
  chave: string;
  requestState: string;
  argumentos: Record<string, unknown>;
  alternativas: string[];
};

export type Task = {
  readonly id: string;
  readonly contextId: string;
  /** trace-id W3C (32 hex) preso a Task na criacao. */
  readonly traceId: string;
  estado: EstadoTask;
  /** Mensagem do agente que acompanha o estado corrente. */
  mensagemDeStatus?: Mensagem;
  readonly historico: Mensagem[];
  readonly artifacts: Artifact[];
  /** Versao da Politica de uso que o agente leu para esta Task (vai no artifact). */
  versaoDaPolitica?: string;
  continuacao?: Continuacao;
};

export const novoId = (prefixo: 'task' | 'ctx' | 'msg' | 'art') => `${prefixo}-${randomBytes(6).toString('hex')}`;

/** Muda o estado da Task, ou lanca se a transicao nao estiver na tabela. */
export function mover(task: Task, para: EstadoTask): void {
  if (!TRANSICOES[task.estado].includes(para)) {
    throw new Error(`Transicao de Task invalida: ${task.estado} -> ${para}`);
  }
  task.estado = para;
}

/** Muda o estado e registra a mensagem do agente no status e no historico. */
export function responder(task: Task, para: EstadoTask, texto: string): void {
  mover(task, para);
  const mensagem: Mensagem = {
    messageId: novoId('msg'),
    role: 'ROLE_AGENT',
    parts: [{ text: texto }],
    taskId: task.id,
    contextId: task.contextId,
  };
  task.mensagemDeStatus = mensagem;
  task.historico.push(mensagem);
}

export function anexarArtifact(task: Task, nome: string, texto: string): void {
  task.artifacts.push({ artifactId: novoId('art'), name: nome, parts: [{ text: texto }] });
}

/** Forma de wire da Task (exemplos/wire/08-10). Sem trace-id nem continuacao. */
export function paraWire(task: Task) {
  const status: { state: EstadoTask; message?: Mensagem } = { state: task.estado };
  if (task.mensagemDeStatus) status.message = task.mensagemDeStatus;
  return {
    id: task.id,
    contextId: task.contextId,
    status,
    history: task.historico,
    artifacts: task.artifacts,
  };
}

export type StoreDeTasks = {
  /** Abre uma Task em SUBMITTED com a mensagem do usuario no historico. */
  abrir(mensagem: Mensagem, traceId: string): Task;
  obter(id: string): Task | undefined;
};

export function criarStoreDeTasks(): StoreDeTasks {
  const tasks = new Map<string, Task>();
  return {
    abrir(mensagem, traceId) {
      const task: Task = {
        id: novoId('task'),
        contextId: novoId('ctx'),
        traceId,
        estado: 'TASK_STATE_SUBMITTED',
        historico: [mensagem],
        artifacts: [],
      };
      tasks.set(task.id, task);
      return task;
    },
    obter: (id) => tasks.get(id),
  };
}
