import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { adjacentColumn, nextKeyboardColumn } from '../src/features/deals/kanban-utils';
import { DARK_INK, INK, themedOption } from '../src/features/reports/EChart';
import { OperatorPanelSlot } from '../src/lib/operator';
import { THEME_STORAGE_KEY, initTheme, setTheme, storedTheme, useTheme } from '../src/lib/theme';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

function ThemeProbe() {
  const [theme, set] = useTheme();
  return (
    <button type="button" onClick={() => set(theme === 'dark' ? 'light' : 'dark')}>
      {theme}
    </button>
  );
}

describe('theme', () => {
  it('persists the choice and applies the dark class', () => {
    expect(storedTheme()).toBeNull();
    expect(initTheme()).toBe('light');
    setTheme('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    document.documentElement.classList.remove('dark');
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('useTheme re-renders subscribers when the theme changes', () => {
    render(<ThemeProbe />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('light');
    act(() => button.click());
    expect(button).toHaveTextContent('dark');
    expect(storedTheme()).toBe('dark');
  });

  it('chart colours switch to the dark ink without touching series colours', () => {
    const option = { textStyle: { color: INK.secondary }, series: [{ itemStyle: { color: '#2a78d6' } }] };
    expect(themedOption(option, 'light')).toBe(option);
    expect(themedOption(option, 'dark')).toEqual({
      textStyle: { color: DARK_INK.secondary },
      series: [{ itemStyle: { color: '#2a78d6' } }],
    });
  });
});

describe('kanban keyboard navigation', () => {
  const cols = { a: ['d1'], b: [], c: ['d2'], d: [] };
  const order = ['a', 'b', 'c', 'd'];

  it('moves by stage order, not by what is visible', () => {
    expect(adjacentColumn(order, cols, null, 'd1', 1)).toBe('b');
    expect(adjacentColumn(order, cols, 'c', 'd1', 1)).toBe('d');
    expect(adjacentColumn(order, cols, 'd2', 'd1', -1)).toBe('b');
    expect(adjacentColumn(order, cols, 'd', 'd1', 1)).toBeNull();
    expect(adjacentColumn(order, cols, null, 'd1', -1)).toBeNull();
  });

  it('chains rapid presses from the previous keyboard target even while the drop target is stale', () => {
    let target: string | null = null;
    const staleOver = 'a';
    for (let i = 0; i < 3; i += 1) target = nextKeyboardColumn(order, cols, target, staleOver, 'd1', 1) ?? target;
    expect(target).toBe('d');
    expect(nextKeyboardColumn(order, cols, 'd', staleOver, 'd1', -1)).toBe('c');
    expect(nextKeyboardColumn(order, cols, null, 'c', 'd1', 1)).toBe('d');
  });
});

describe('Ask operator slot', () => {
  const renderSlot = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OperatorPanelSlot record={{ type: 'deal', id: 'd1', label: 'Big deal' }} />
      </QueryClientProvider>,
    );

  it('renders nothing when no operator is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ operator: null }));
    const { container } = renderSlot();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(document.querySelector('script[data-operator-embed]')).toBeNull();
  });

  it('loads the configured script once and renders the web component with record context', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        operator: {
          scriptUrl: 'http://127.0.0.1:4611/embed/ask-operator.js',
          agentUrl: 'http://agent',
          consoleUrl: null,
        },
      }),
    );
    renderSlot();
    const script = await waitFor(() => {
      const el = document.querySelector<HTMLScriptElement>('script[data-operator-embed]');
      expect(el).not.toBeNull();
      return el as HTMLScriptElement;
    });
    expect(script.type).toBe('module');
    expect(script.src).toBe('http://127.0.0.1:4611/embed/ask-operator.js');
    act(() => script.dispatchEvent(new Event('load')));
    const el = await waitFor(() => {
      const found = document.querySelector('ask-operator');
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(el.getAttribute('record-type')).toBe('deal');
    expect(el.getAttribute('record-id')).toBe('d1');
    expect(el.getAttribute('record-label')).toBe('Big deal');
    expect(el.getAttribute('agent-url')).toBe('http://agent');
    expect(el.hasAttribute('console-url')).toBe(false);
  });
});
