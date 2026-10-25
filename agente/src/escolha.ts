// Resposta a uma Pausa em forma fixa: `escolha=<id>` (Escolha) ou
// `escolha=recusar` (Recusa). O agente so confere o id contra o enum que o
// servidor MCP ofereceu; a Sala em si quem valida e o servidor, no retry.

export type Resposta = { tipo: 'escolha'; sala: string } | { tipo: 'recusa' };

const FORMA = /^escolha=(\S+)$/;

/** A Resposta, ou undefined se o texto nao e `escolha=recusar` nem `escolha=<id do enum>`. */
export function interpretarResposta(texto: string, alternativas: readonly string[]): Resposta | undefined {
  const id = FORMA.exec(texto.trim())?.[1];
  if (id === 'recusar') return { tipo: 'recusa' };
  if (id !== undefined && alternativas.includes(id)) return { tipo: 'escolha', sala: id };
  return undefined;
}
