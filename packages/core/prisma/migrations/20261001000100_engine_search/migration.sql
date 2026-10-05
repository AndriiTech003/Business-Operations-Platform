CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "workflows" ADD CONSTRAINT "workflows_status_check" CHECK ("status" IN ('draft', 'active', 'paused', 'archived'));
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_status_check" CHECK ("status" IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled'));
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_status_check" CHECK ("status" IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled'));
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_source_check" CHECK ("source" IN ('workflow', 'agent'));
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'cancelled'));
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE;
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_run_fk" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE;

CREATE INDEX "step_runs_due_idx" ON "step_runs" ("status", "scheduled_for") WHERE "status" IN ('pending', 'waiting');
CREATE INDEX "step_runs_lease_idx" ON "step_runs" ("lease_expires_at") WHERE "status" = 'running';
CREATE INDEX "step_runs_wait_idx" ON "step_runs" (("wait"->>'entity'), ("wait"->>'id')) WHERE "status" = 'waiting';
CREATE INDEX "outbox_unpublished_idx" ON "outbox" ("created_at") WHERE "published_at" IS NULL;
CREATE INDEX "email_messages_queued_idx" ON "email_messages" ("created_at") WHERE "status" IN ('queued', 'sending');

ALTER TABLE "search_documents" ADD COLUMN "tsv" tsvector;

CREATE FUNCTION search_documents_tsv() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.subtitle, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.body, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER search_documents_tsv_trigger BEFORE INSERT OR UPDATE ON "search_documents"
  FOR EACH ROW EXECUTE FUNCTION search_documents_tsv();

CREATE INDEX "search_documents_tsv_idx" ON "search_documents" USING gin ("tsv");
CREATE INDEX "search_documents_title_trgm_idx" ON "search_documents" USING gin ("title" gin_trgm_ops);
CREATE INDEX "companies_name_trgm_idx" ON "companies" USING gin ("name" gin_trgm_ops);
