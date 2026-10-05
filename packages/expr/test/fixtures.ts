import { T, hydrate } from '../src/index';
import type { EvalEnv, Node, Type, TypeContext, UserValue } from '../src/index';

export const companyType = T.object(
  {
    name: T.string,
    owner: T.user,
    region: T.nullable(T.string),
  },
  'Company',
);

export const contactType = T.object({ email: T.string, firstName: T.string }, 'Contact');

export const invoiceType = T.object(
  {
    id: T.string,
    number: T.string,
    status: T.string,
    totalCents: T.number,
    total: T.money,
    currency: T.string,
    dueDate: T.date,
    paidAt: T.nullable(T.date),
    company: companyType,
    contact: T.nullable(contactType),
    tags: T.list(T.string),
    paid: T.nullable(T.bool),
    archived: T.bool,
    custom: T.object({
      region: { type: T.nullable(T.string), label: 'Region', custom: true },
      score: { type: T.nullable(T.number), label: 'Score', custom: true },
    }),
  },
  'Invoice',
);

export const stepsType = T.object({
  remind: T.object({ output: T.object({ messageId: T.string }) }),
  approve: T.object({ output: T.object({ decidedBy: T.user, comment: T.nullable(T.string) }) }),
});

export const varTypes: Record<string, Type> = {
  invoice: invoiceType,
  steps: stepsType,
  n: T.number,
  nn: T.nullable(T.number),
  s: T.string,
  ns: T.nullable(T.string),
  b: T.bool,
  nb: T.nullable(T.bool),
  d: T.date,
  dur: T.duration,
  m: T.money,
  eur: T.money,
  list: T.list(T.number),
  nl: T.nullable(T.list(T.number)),
  owner: T.nullable(T.user),
  anyv: T.any,
  meta: T.any,
};

export const ctx: TypeContext = { vars: varTypes };
export const secretCtx: TypeContext = { vars: varTypes, allowSecret: true };

export const NOW = new Date('2024-05-10T12:00:00.000Z');

export const olga: UserValue = { id: 'u1', name: 'Olga', email: 'olga@example.com' };
export const ivan: UserValue = { id: 'u2', name: 'Ivan', email: 'ivan@example.com' };

const json: Record<string, unknown> = {
  invoice: {
    id: 'i1',
    number: 'INV-1',
    status: 'sent',
    totalCents: 123456,
    total: 123456,
    currency: 'EUR',
    dueDate: '2024-05-01T00:00:00.000Z',
    paidAt: null,
    company: { name: 'Acme', owner: olga, region: null },
    contact: null,
    tags: ['urgent', 'vip'],
    paid: null,
    archived: false,
    custom: { region: 'EU', score: 7 },
  },
  steps: {
    remind: { output: { messageId: 'msg-1' } },
    approve: { output: { decidedBy: ivan, comment: null } },
  },
  n: 10,
  nn: null,
  s: 'Hello',
  ns: null,
  b: true,
  nb: null,
  d: '2024-05-01T00:00:00.000Z',
  dur: 3600000,
  m: { cents: 1000, currency: 'USD' },
  eur: { cents: 500, currency: 'EUR' },
  list: [1, 2, 3],
  nl: null,
  owner: null,
  anyv: { x: 1 },
  meta: { a: 1, b: [true, null] },
};

export function hydrateVars(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(varTypes)) out[k] = hydrate(json[k], t);
  return out;
}

export function makeEnv(extra: Partial<EvalEnv> = {}): EvalEnv {
  return {
    vars: hydrateVars(),
    now: () => NOW,
    host: {
      role: (name: string) => (name === 'manager' ? [olga, ivan] : []),
      user: (id: string) => [olga, ivan].find((u) => u.id === id) ?? null,
      secret: (name: string) => (name === 'token' ? 's3cr3t' : ''),
    },
    ...extra,
  };
}

export function sexpr(n: Node): string {
  switch (n.type) {
    case 'number':
      return String(n.value);
    case 'string':
      return JSON.stringify(n.value);
    case 'bool':
      return String(n.value);
    case 'null':
      return 'null';
    case 'ident':
      return n.name;
    case 'list':
      return `[${n.items.map(sexpr).join(' ')}]`;
    case 'member':
      return `(${n.optional ? '?.' : '.'} ${sexpr(n.object)} ${n.property})`;
    case 'index':
      return `([] ${sexpr(n.object)} ${sexpr(n.index)})`;
    case 'call':
      return `(call ${[n.callee, ...n.args.map(sexpr)].join(' ')})`;
    case 'unary':
      return `(${n.op} ${sexpr(n.operand)})`;
    case 'binary':
      return `(${n.op} ${sexpr(n.left)} ${sexpr(n.right)})`;
    case 'ternary':
      return `(? ${sexpr(n.test)} ${sexpr(n.consequent)} ${sexpr(n.alternate)})`;
  }
}
