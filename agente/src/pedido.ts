// Pedido em forma fixa. O agente nao valida datas nem Salas: isso e do
// servidor MCP. So separa os campos.

export type Pedido = { sala: string; inicio: string; fim: string; responsavel: string };

export const PEDIDO_INVALIDO =
  'Pedido invalido: use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>';

const FORMA = /^reservar[ \t]+sala=(\S+)[ \t]+inicio=(\S+)[ \t]+fim=(\S+)[ \t]+responsavel=(.*)$/;

/** O Pedido, ou undefined se o texto nao casa com a forma fixa. */
export function interpretarPedido(texto: string): Pedido | undefined {
  const m = FORMA.exec(texto.trim());
  if (!m) return undefined;
  const responsavel = m[4].trim();
  if (!responsavel) return undefined;
  return { sala: m[1], inicio: m[2], fim: m[3], responsavel };
}
