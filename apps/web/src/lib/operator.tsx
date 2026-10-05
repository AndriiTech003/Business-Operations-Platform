import { createElement, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AppConfigDto } from '@bop/contracts';
import { API_URL } from './api';

const scripts = new Map<string, Promise<void>>();

export function loadModuleScript(url: string): Promise<void> {
  const known = scripts.get(url);
  if (known !== undefined) return known;
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.type = 'module';
    el.src = url;
    el.async = true;
    el.dataset['operatorEmbed'] = 'true';
    el.onload = () => resolve();
    el.onerror = () => {
      scripts.delete(url);
      el.remove();
      reject(new Error(`Could not load ${url}`));
    };
    document.head.appendChild(el);
  });
  scripts.set(url, promise);
  return promise;
}

export function useAppConfig() {
  return useQuery({
    queryKey: ['app-config'],
    queryFn: async ({ signal }): Promise<AppConfigDto> => {
      const res = await fetch(`${API_URL}/v1/app-config`, { signal });
      if (!res.ok) return { operator: null };
      return (await res.json()) as AppConfigDto;
    },
    staleTime: Infinity,
    retry: false,
  });
}

export interface OperatorRecord {
  type: 'company' | 'contact' | 'deal' | 'invoice';
  id: string;
  label: string;
}

export function OperatorPanelSlot({ record }: { record: OperatorRecord }) {
  const config = useAppConfig();
  const operator = config.data?.operator ?? null;
  const scriptUrl = operator?.scriptUrl ?? null;
  const [state, setState] = useState<{ url: string; status: 'ready' | 'failed' } | null>(null);
  useEffect(() => {
    if (scriptUrl === null) return undefined;
    let active = true;
    loadModuleScript(scriptUrl).then(
      () => {
        if (active) setState({ url: scriptUrl, status: 'ready' });
      },
      () => {
        if (active) setState({ url: scriptUrl, status: 'failed' });
      },
    );
    return () => {
      active = false;
    };
  }, [scriptUrl]);
  if (operator === null || scriptUrl === null) return null;
  const status = state?.url === scriptUrl ? state.status : 'loading';
  if (status === 'failed') return null;
  return (
    <div className="inline-flex" data-testid="operator-slot" data-status={status}>
      {status === 'ready'
        ? createElement('ask-operator', {
            'record-type': record.type,
            'record-id': record.id,
            'record-label': record.label,
            ...(operator.agentUrl === null ? {} : { 'agent-url': operator.agentUrl }),
            'console-url': operator.consoleUrl ?? undefined,
          })
        : null}
    </div>
  );
}
