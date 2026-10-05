import { useQuery } from '@tanstack/react-query';
import type { CustomFieldDefDto, CustomFieldEntity, EmailTemplateDto, MemberDto, PipelineDto } from '@bop/contracts';
import type { CustomFieldMap } from '@bop/workflow-core';
import { useMemo } from 'react';
import { api, asList } from './api';
import { keys } from './query-keys';

export function useMembers() {
  return useQuery({
    queryKey: keys.members,
    queryFn: async () => asList<MemberDto>(await api.get('/v1/members')),
    staleTime: 60_000,
  });
}

export function useMemberMap(): Map<string, MemberDto> {
  const { data } = useMembers();
  return useMemo(() => new Map((data ?? []).map((m) => [m.id, m])), [data]);
}

export function useCustomFields() {
  return useQuery({
    queryKey: keys.customFields,
    queryFn: async () => asList<CustomFieldDefDto>(await api.get('/v1/custom-fields')),
    staleTime: 60_000,
  });
}

export function useCustomFieldsFor(entity: CustomFieldEntity | 'invoice' | 'task'): CustomFieldDefDto[] {
  const { data } = useCustomFields();
  return useMemo(
    () => (data ?? []).filter((d) => d.entity === entity).sort((a, b) => a.position - b.position),
    [data, entity],
  );
}

export function toCustomFieldMap(defs: CustomFieldDefDto[]): CustomFieldMap {
  const map: CustomFieldMap = {};
  for (const d of defs) {
    const list = map[d.entity] ?? [];
    list.push({ key: d.key, label: d.label, type: d.type, options: d.options });
    map[d.entity] = list;
  }
  return map;
}

export function useCustomFieldMap(): CustomFieldMap {
  const { data } = useCustomFields();
  return useMemo(() => toCustomFieldMap(data ?? []), [data]);
}

export function usePipelines() {
  return useQuery({
    queryKey: keys.pipelines,
    queryFn: async () => asList<PipelineDto>(await api.get('/v1/pipelines')),
    staleTime: 60_000,
  });
}

export function useStageMap() {
  const { data } = usePipelines();
  return useMemo(() => {
    const map = new Map<string, { id: string; name: string; kind: string; probability: number; pipelineId: string }>();
    for (const p of data ?? []) for (const s of p.stages) map.set(s.id, { ...s, pipelineId: p.id });
    return map;
  }, [data]);
}

export function useEmailTemplates(enabled = true) {
  return useQuery({
    queryKey: keys.emailTemplates,
    queryFn: async () => asList<EmailTemplateDto>(await api.get('/v1/email-templates')),
    staleTime: 60_000,
    enabled,
  });
}
