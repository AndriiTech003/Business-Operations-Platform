ALTER TABLE "companies" ADD COLUMN "source" TEXT;

ALTER TABLE "search_documents" ADD COLUMN "external" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "effect_log" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'engine';
ALTER TABLE "effect_log" ADD COLUMN "request_hash" TEXT;
ALTER TABLE "effect_log" ADD CONSTRAINT "effect_log_origin_check" CHECK ("origin" IN ('engine', 'api'));
ALTER TABLE "effect_log" DROP CONSTRAINT "effect_log_pkey";
ALTER TABLE "effect_log" ADD CONSTRAINT "effect_log_pkey" PRIMARY KEY ("tenant_id", "origin", "idempotency_key");
CREATE INDEX "effect_log_key_idx" ON "effect_log" ("idempotency_key");
