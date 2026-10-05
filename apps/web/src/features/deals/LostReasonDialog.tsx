import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  NativeSelect,
  Textarea,
} from '@bop/ui';

const REASONS = [
  'Price too high',
  'Chose a competitor',
  'No budget',
  'No decision / went dark',
  'Bad timing',
  'Missing features',
];

export function LostReasonDialog({
  open,
  dealTitle,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  dealTitle: string;
  onCancel(): void;
  onConfirm(reason: string): void;
}) {
  const [preset, setPreset] = useState('');
  const [reason, setReason] = useState('');
  const text = reason.trim() !== '' ? reason.trim() : preset;
  const close = () => {
    setPreset('');
    setReason('');
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          close();
          onCancel();
        }
      }}
    >
      <DialogContent size="sm" data-testid="lost-reason-dialog">
        <DialogHeader>
          <DialogTitle>Why was this deal lost?</DialogTitle>
          <DialogDescription>{dealTitle}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text === '') return;
            onConfirm(text);
            close();
          }}
        >
          <Field label="Common reasons" htmlFor="lost-preset">
            <NativeSelect id="lost-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
              <option value="">Choose…</option>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Reason" htmlFor="lost-reason" hint="Required. Shown on the deal and used in reports.">
            <Textarea
              id="lost-reason"
              data-testid="lost-reason"
              autoFocus
              value={reason}
              placeholder={preset || 'What happened?'}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                close();
                onCancel();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" data-testid="dialog-submit" disabled={text === ''}>
              Mark as lost
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
