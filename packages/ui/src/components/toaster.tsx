import { Toaster as Sonner, toast } from 'sonner';

export function Toaster() {
  return <Sonner position="bottom-right" richColors closeButton toastOptions={{ className: 'text-sm' }} />;
}

export { toast };
