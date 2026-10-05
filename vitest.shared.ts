import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const workspaceAlias = {
  '@bop/contracts': r('./packages/contracts/src/index.ts'),
  '@bop/workflow-core': r('./packages/workflow-core/src/index.ts'),
  '@bop/core/testing': r('./packages/core/src/testing/index.ts'),
  '@bop/core': r('./packages/core/src/index.ts'),
  '@ashamrai/expr': r('./packages/expr/src/index.ts'),
};
