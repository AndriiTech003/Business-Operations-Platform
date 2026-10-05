import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportJobDto } from '@bop/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Progress,
  Textarea,
  toast,
} from '@bop/ui';
import { CircleCheck, Download, FileUp, TriangleAlert } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { keys } from '../lib/query-keys';

const SAMPLE: Record<'company' | 'contact', string> = {
  company: 'name,domain,industry,size\nAcme Robotics,acme-robotics.example,Manufacturing,120',
  contact: 'firstName,lastName,email,phone,title,company\nJane,Doe,jane@acme.example,+1 555 0100,CTO,Acme Robotics',
};

export function ImportDialog({
  entity,
  open,
  onOpenChange,
}: {
  entity: 'company' | 'contact';
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('import.csv');
  const [mode, setMode] = useState<'merge' | 'skip' | 'create'>('merge');
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api.post<ImportJobDto>(`/v1/${entity === 'company' ? 'companies' : 'contacts'}/import`, {
        entity,
        fileName,
        csv,
        mode,
      }),
    onSuccess: (job) => setJobId(job.id),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const job = useQuery({
    queryKey: keys.importJob(jobId ?? ''),
    queryFn: () => api.get<ImportJobDto>(`/v1/imports/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data?.status === 'completed' || q.state.data?.status === 'failed' ? false : 1000),
  });
  const data = job.data ?? start.data;
  const finished = data?.status === 'completed' || data?.status === 'failed';
  const pct =
    data && data.total > 0 ? Math.round((data.processed / data.total) * 100) : data?.status === 'completed' ? 100 : 5;

  const reset = () => {
    setCsv('');
    setJobId(null);
    start.reset();
  };

  const downloadErrors = () => {
    if (!data) return;
    const body = ['row,message', ...data.errors.map((e) => `${e.row},"${e.message.replace(/"/g, '""')}"`)].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.csv$/, '')}-errors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          if (finished) void qc.invalidateQueries({ queryKey: keys[entity].lists() });
          reset();
        }
      }}
    >
      <DialogContent size="lg" data-testid="import-dialog">
        <DialogHeader>
          <DialogTitle>Import {entity === 'company' ? 'companies' : 'contacts'} from CSV</DialogTitle>
          <DialogDescription>
            The first row must contain column names. Large files are processed in the background.
          </DialogDescription>
        </DialogHeader>
        {data === undefined ? (
          <div className="grid gap-3">
            <Field label="CSV file" htmlFor="import-file">
              <Input
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                data-testid="import-file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f === undefined) return;
                  setFileName(f.name);
                  void f.text().then(setCsv);
                }}
              />
            </Field>
            <Field
              label="…or paste CSV"
              htmlFor="import-csv"
              hint={
                <button type="button" className="cursor-pointer underline" onClick={() => setCsv(SAMPLE[entity])}>
                  Insert an example
                </button>
              }
            >
              <Textarea
                id="import-csv"
                data-testid="import-csv"
                className="min-h-32 font-mono text-xs"
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
              />
            </Field>
            <Field label="When a record already exists" htmlFor="import-mode">
              <NativeSelect
                id="import-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'merge' | 'skip' | 'create')}
                data-testid="import-mode"
              >
                <option value="merge">Merge — update existing records</option>
                <option value="skip">Skip — keep existing records unchanged</option>
                <option value="create">Create — always create new records</option>
              </NativeSelect>
            </Field>
          </div>
        ) : (
          <div className="grid gap-3" data-testid="import-progress">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{data.fileName}</span>
              <Badge
                variant={data.status === 'completed' ? 'success' : data.status === 'failed' ? 'destructive' : 'info'}
              >
                {data.status}
              </Badge>
            </div>
            <Progress value={pct} indicatorClassName={data.status === 'failed' ? 'bg-destructive' : undefined} />
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              {(
                [
                  ['Processed', `${data.processed}/${data.total}`],
                  ['Created', data.created],
                  ['Updated', data.updated],
                  ['Failed', data.failed],
                ] as const
              ).map(([label, v]) => (
                <div key={label} className="rounded-md border p-2">
                  <p className="text-base font-semibold tabular-nums">{v}</p>
                  <p className="text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
            {data.status === 'completed' && data.failed === 0 ? (
              <Alert icon={<CircleCheck className="text-success" />} title="Import finished">
                All rows were imported.
              </Alert>
            ) : null}
            {data.errors.length > 0 ? (
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1 text-sm font-medium">
                    <TriangleAlert className="size-4 text-warning" /> Error report
                  </p>
                  <Button size="xs" variant="outline" onClick={downloadErrors}>
                    <Download /> Download
                  </Button>
                </div>
                <div className="max-h-48 overflow-auto rounded-md border text-xs">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="px-2 py-1 text-left">Row</th>
                        <th className="px-2 py-1 text-left">Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.errors.map((e, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1 tabular-nums">{e.row}</td>
                          <td className="px-2 py-1">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {data === undefined ? (
            <Button
              data-testid="dialog-submit"
              disabled={csv.trim() === ''}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              <FileUp /> Start import
            </Button>
          ) : (
            <Button variant="outline" disabled={!finished} onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
