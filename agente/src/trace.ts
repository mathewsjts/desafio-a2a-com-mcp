// Propagacao do W3C traceparent: a Task assume o trace-id do header na criacao
// (ou gera um), e cada request MCP leva esse trace-id com um span-id novo.

import { randomBytes } from 'node:crypto';

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZEROS = /^0+$/;

/** trace-id do header `traceparent`, ou um novo se o header faltar ou for invalido. */
export function traceIdDoHeader(header: string | string[] | undefined): string {
  const m = typeof header === 'string' ? TRACEPARENT.exec(header.trim().toLowerCase()) : null;
  if (m && m[1] !== 'ff' && !ZEROS.test(m[2]) && !ZEROS.test(m[3])) return m[2];
  return randomBytes(16).toString('hex');
}

/** traceparent com o trace-id dado e um span-id novo. */
export function novoTraceparent(traceId: string): string {
  return `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
}
