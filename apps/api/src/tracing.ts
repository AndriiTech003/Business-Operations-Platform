import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export function startTracing(serviceName: string): (() => Promise<void>) | null {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') return null;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` })),
    ],
  });
  provider.register();
  return () => provider.shutdown();
}
