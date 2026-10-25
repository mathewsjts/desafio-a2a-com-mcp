// Roda o validador do starter contra processos recem-iniciados.
//
// O validador muda a Agenda em sequencia, entao cada execucao precisa de um
// servidor MCP e de um agente novos. Este script:
//   1. confere que as portas estao livres (processos antigos invalidariam o resultado);
//   2. sobe o servidor MCP e o agente como filhos;
//   3. roda `validador/validar.py` com um Python 3.10+;
//   4. derruba os filhos e sai com o codigo do validador.
// O stderr de cada processo fica em validar-servidor-mcp.log e validar-agente.log.
//
// REQUEST_STATE_SECRET vem do ambiente; se faltar, um segredo aleatorio e gerado
// so para esta execucao (nunca e gravado).

import { spawnSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { iniciarAgente, iniciarServidorMcp, RAIZ, type Processo } from '../test/harness.ts';

const PORTA_MCP = Number(process.env.MCP_PORT ?? 7301);
const PORTA_AGENTE = Number(process.env.AGENT_PORT ?? 7300);

export function acharPython(): string | undefined {
  const candidatos = [
    process.env.PYTHON,
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
  ].filter((c): c is string => Boolean(c));
  for (const cmd of candidatos) {
    const r = spawnSync(cmd, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const [maj, min] = r.stdout.trim().split('.').map(Number);
    if (maj > 3 || (maj === 3 && min >= 10)) return cmd;
  }
  return undefined;
}

function portaOcupada(porta: number): Promise<boolean> {
  return new Promise((ok) => {
    const sock = connect(porta, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); ok(true); });
    sock.once('error', () => { sock.destroy(); ok(false); });
  });
}

async function main(): Promise<number> {
  const python = acharPython();
  if (!python) {
    console.error('Python 3.10+ nao encontrado. Defina PYTHON=/caminho/para/python3.10+');
    return 2;
  }
  for (const porta of [PORTA_MCP, PORTA_AGENTE]) {
    if (await portaOcupada(porta)) {
      console.error(`A porta ${porta} ja esta em uso. Encerre os processos antigos: o validador exige processos recem-iniciados.`);
      return 2;
    }
  }

  const env = { REQUEST_STATE_SECRET: process.env.REQUEST_STATE_SECRET ?? randomBytes(32).toString('hex') };
  const processos: Processo[] = [];
  try {
    const mcp = await iniciarServidorMcp({ porta: PORTA_MCP, env });
    processos.push(mcp);
    const agente = await iniciarAgente({ porta: PORTA_AGENTE, mcpUrl: `${mcp.url}/mcp`, env });
    processos.push(agente);

    const filho = spawn(
      python,
      [join(RAIZ, 'validador', 'validar.py'), '--agente', agente.url, '--mcp', mcp.url],
      { cwd: RAIZ, stdio: 'inherit' },
    );
    return await new Promise<number>((ok) => filho.once('exit', (codigo) => ok(codigo ?? 1)));
  } finally {
    for (const p of processos.reverse()) {
      await p.parar();
      writeFileSync(join(RAIZ, `validar-${p.nome}.log`), p.linhas().join('\n') + '\n');
    }
  }
}

process.exit(await main());
