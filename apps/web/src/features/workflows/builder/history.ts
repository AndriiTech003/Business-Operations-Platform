import { useCallback, useReducer } from 'react';
import type { WorkflowDefinition } from '@bop/contracts';

interface State {
  past: WorkflowDefinition[];
  present: WorkflowDefinition;
  future: WorkflowDefinition[];
  lastTag: string | null;
  lastAt: number;
  revision: number;
}

type Action =
  | { type: 'set'; def: WorkflowDefinition; tag?: string; transient?: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; def: WorkflowDefinition };

const LIMIT = 100;
const COALESCE_MS = 900;

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set': {
      if (action.def === state.present) return state;
      const now = Date.now();
      const coalesce =
        action.transient === true ||
        (action.tag !== undefined && action.tag === state.lastTag && now - state.lastAt < COALESCE_MS);
      if (coalesce)
        return {
          ...state,
          present: action.def,
          lastTag: action.tag ?? state.lastTag,
          lastAt: now,
          revision: state.revision + 1,
        };
      return {
        past: [...state.past, state.present].slice(-LIMIT),
        present: action.def,
        future: [],
        lastTag: action.tag ?? null,
        lastAt: now,
        revision: state.revision + 1,
      };
    }
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (prev === undefined) return state;
      return {
        past: state.past.slice(0, -1),
        present: prev,
        future: [state.present, ...state.future],
        lastTag: null,
        lastAt: 0,
        revision: state.revision + 1,
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (next === undefined) return state;
      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
        lastTag: null,
        lastAt: 0,
        revision: state.revision + 1,
      };
    }
    case 'reset':
      return { past: [], present: action.def, future: [], lastTag: null, lastAt: 0, revision: state.revision + 1 };
  }
}

export function useDefinitionHistory(initial: WorkflowDefinition) {
  const [state, dispatch] = useReducer(reducer, {
    past: [],
    present: initial,
    future: [],
    lastTag: null,
    lastAt: 0,
    revision: 0,
  });
  const set = useCallback(
    (def: WorkflowDefinition, opts?: { tag?: string; transient?: boolean }) => dispatch({ type: 'set', def, ...opts }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((def: WorkflowDefinition) => dispatch({ type: 'reset', def }), []);
  return {
    definition: state.present,
    revision: state.revision,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    set,
    undo,
    redo,
    reset,
  };
}
