import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder as placeholderExt,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { forceLinting, linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import type { Type, TypeContext } from '@ashamrai/expr';
import { cn } from '@bop/ui';
import {
  classifyTokens,
  createCompletionSource,
  diagnoseExpression,
  type ExprDiagnostic,
  type TokenClass,
} from './language';

const MARKS: Record<TokenClass, Decoration> = {
  number: Decoration.mark({ class: 'cm-x-number' }),
  string: Decoration.mark({ class: 'cm-x-string' }),
  keyword: Decoration.mark({ class: 'cm-x-keyword' }),
  field: Decoration.mark({ class: 'cm-x-field' }),
  fn: Decoration.mark({ class: 'cm-x-fn' }),
  var: Decoration.mark({ class: 'cm-x-var' }),
  op: Decoration.mark({ class: 'cm-x-op' }),
  punct: Decoration.mark({ class: 'cm-x-punct' }),
  tpl: Decoration.mark({ class: 'cm-x-tpl' }),
  error: Decoration.mark({ class: 'cm-x-error' }),
};

function exprHighlighter(template: boolean): Extension {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const src = view.state.doc.toString();
    let last = -1;
    for (const t of classifyTokens(src, template)) {
      if (t.from < last || t.to <= t.from) continue;
      builder.add(t.from, t.to, MARKS[t.cls]);
      last = t.to;
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'var(--card)', border: '1px solid var(--input)', borderRadius: '6px' },
  '&.cm-focused': {
    outline: 'none',
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 2px color-mix(in oklab, var(--ring) 25%, transparent)',
  },
  '.cm-content': { fontFamily: 'var(--font-mono)', padding: '6px 0', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-x-number': { color: 'oklch(0.55 0.15 150)' },
  '.cm-x-string': { color: 'oklch(0.55 0.15 40)' },
  '.cm-x-keyword': { color: 'oklch(0.5 0.2 300)', fontWeight: '600' },
  '.cm-x-field': { color: 'oklch(0.5 0.15 245)' },
  '.cm-x-fn': { color: 'oklch(0.5 0.18 20)' },
  '.cm-x-var': { color: 'oklch(0.45 0.18 268)', fontWeight: '600' },
  '.cm-x-op': { color: 'oklch(0.5 0.02 265)' },
  '.cm-x-punct': { color: 'oklch(0.55 0.02 265)' },
  '.cm-x-tpl': { color: 'oklch(0.55 0.2 330)', fontWeight: '700' },
  '.cm-x-error': { textDecoration: 'underline wavy var(--destructive)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '16em' },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    borderRadius: '6px',
    backgroundColor: 'var(--popover)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)',
  },
  '.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal', marginLeft: '0.75em' },
  '.cm-completionInfo': { padding: '4px 8px', fontSize: '12px', maxWidth: '320px' },
  '.cm-diagnostic': { fontSize: '12px' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--destructive)',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warning)',
    textUnderlineOffset: '3px',
  },
  '.cm-gutters': { display: 'none' },
});

export interface ExpressionEditorHandle {
  focus(pos?: number): void;
  view(): EditorView | null;
}

export interface ExpressionEditorProps {
  value: string;
  onChange(value: string): void;
  context: TypeContext;
  template?: boolean;
  expected?: readonly Type[];
  multiline?: boolean;
  placeholder?: string;
  testId?: string;
  id?: string;
  ariaLabel?: string;
  readOnly?: boolean;
  invalid?: boolean;
  className?: string;
  onDiagnostics?(diagnostics: ExprDiagnostic[]): void;
  onFocus?(): void;
  onBlur?(): void;
}

export const ExpressionEditor = forwardRef<ExpressionEditorHandle, ExpressionEditorProps>(function ExpressionEditor(
  {
    value,
    onChange,
    context,
    template = false,
    expected,
    multiline = false,
    placeholder,
    testId,
    id,
    ariaLabel,
    readOnly = false,
    invalid = false,
    className,
    onDiagnostics,
    onFocus,
    onBlur,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ context, expected, onChange, onDiagnostics, onFocus, onBlur });
  const initialValue = useRef(value);
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  });

  useEffect(() => {
    latest.current = { context, expected, onChange, onDiagnostics, onFocus, onBlur };
  });

  useImperativeHandle(ref, () => ({
    focus(pos?: number) {
      const v = viewRef.current;
      if (v === null) return;
      v.focus();
      if (pos !== undefined) v.dispatch({ selection: { anchor: Math.min(pos, v.state.doc.length) } });
    },
    view: () => viewRef.current,
  }));

  useEffect(() => {
    if (host.current === null) return undefined;
    const singleLine: Extension[] = multiline
      ? []
      : [
          EditorState.transactionFilter.of((tr) => (tr.docChanged && tr.newDoc.lines > 1 ? [] : tr)),
          Prec.low(keymap.of([{ key: 'Enter', run: () => true }])),
        ];
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          history(),
          closeBrackets(),
          autocompletion({
            override: [createCompletionSource(() => latest.current.context, template)],
            icons: true,
            activateOnTyping: true,
            closeOnBlur: true,
          }),
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            { key: 'Ctrl-Space', run: startCompletion },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          linter(
            (v): Diagnostic[] => {
              const diags = diagnoseExpression(v.state.doc.toString(), latest.current.context, {
                template,
                expected: latest.current.expected,
              });
              latest.current.onDiagnostics?.(diags);
              return diags.map((d) => ({
                from: d.from,
                to: d.to === d.from ? Math.min(d.to + 1, v.state.doc.length) : d.to,
                severity: d.severity,
                message: d.message,
                source: d.code,
              }));
            },
            { delay: 150 },
          ),
          lintGutter(),
          exprHighlighter(template),
          multiline ? EditorView.lineWrapping : [],
          placeholder ? placeholderExt(placeholder) : [],
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel ?? 'Expression',
            ...(id ? { id } : {}),
            spellcheck: 'false',
            autocapitalize: 'off',
            autocorrect: 'off',
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
            if (u.focusChanged) {
              if (u.view.hasFocus) latest.current.onFocus?.();
              else latest.current.onBlur?.();
            }
          }),
          theme,
          ...singleLine,
        ],
      }),
    });
    viewRef.current = view;
    if (view.state.doc.toString() !== latestValue.current)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: latestValue.current } });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [template, multiline, readOnly, placeholder, ariaLabel, id]);

  useEffect(() => {
    const v = viewRef.current;
    if (v === null) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      const head = Math.min(v.state.selection.main.head, value.length);
      v.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: head } });
    }
  }, [value]);

  useEffect(() => {
    const v = viewRef.current;
    if (v !== null) forceLinting(v);
  }, [context, expected]);

  return (
    <div
      ref={host}
      data-testid={testId}
      data-invalid={invalid || undefined}
      className={cn('min-w-0 [&_.cm-editor]:w-full', invalid && '[&_.cm-editor]:!border-destructive', className)}
    />
  );
});
