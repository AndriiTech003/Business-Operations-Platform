import { children } from './parser';
import type { HostCalls, Node, ParsedTemplate } from './types';

function roots(input: Node | ParsedTemplate): Node[] {
  if ('parts' in input) {
    const out: Node[] = [];
    for (const part of input.parts) if (part.kind === 'expr') out.push(part.ast);
    return out;
  }
  return [input];
}

function walk(nodes: Node[], visit: (n: Node) => boolean): void {
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    if (!visit(n)) continue;
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k !== undefined) stack.push(k);
    }
  }
}

export function collectHostCalls(input: Node | ParsedTemplate): HostCalls {
  const result: HostCalls = { roles: [], users: [], secrets: [], dynamicUsers: false };
  const add = (list: string[], v: string): void => {
    if (!list.includes(v)) list.push(v);
  };
  walk(roots(input), (n) => {
    if (n.type !== 'call') return true;
    const arg = n.args[0];
    const literal = arg !== undefined && arg.type === 'string' ? arg.value : null;
    if (n.callee === 'role' && literal !== null) add(result.roles, literal);
    if (n.callee === 'secret' && literal !== null) add(result.secrets, literal);
    if (n.callee === 'user') {
      if (literal !== null) add(result.users, literal);
      else result.dynamicUsers = true;
    }
    return true;
  });
  return result;
}

function pathOf(n: Node): string[] | null {
  if (n.type === 'ident') return [n.name];
  if (n.type === 'member') {
    const p = pathOf(n.object);
    return p === null ? null : [...p, n.property];
  }
  if (n.type === 'index' && n.index.type === 'string') {
    const p = pathOf(n.object);
    return p === null ? null : [...p, n.index.value];
  }
  return null;
}

export function collectPaths(input: Node | ParsedTemplate): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const add = (p: string[]): void => {
    const key = JSON.stringify(p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  walk(roots(input), (n) => {
    const p = pathOf(n);
    if (p !== null) {
      add(p);
      return false;
    }
    return true;
  });
  return out;
}
