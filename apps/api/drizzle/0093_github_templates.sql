CREATE TYPE "core"."github_sync_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "core"."github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_uq" UNIQUE("installation_id")
);
--> statement-breakpoint
ALTER TABLE "core"."github_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."github_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"target_branch" text DEFAULT 'main' NOT NULL,
	"directory" text DEFAULT 'emails' NOT NULL,
	"last_commit_sha" text,
	"last_synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."github_repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."github_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"status" "core"."github_sync_status" DEFAULT 'pending' NOT NULL,
	"outcomes" jsonb,
	"problems" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core"."github_syncs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "github_repository_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."github_installations" ADD CONSTRAINT "github_installations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."github_repositories" ADD CONSTRAINT "github_repositories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."github_repositories" ADD CONSTRAINT "github_repositories_installation_id_github_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "core"."github_installations"("installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."github_syncs" ADD CONSTRAINT "github_syncs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."github_syncs" ADD CONSTRAINT "github_syncs_repository_id_github_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "core"."github_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_tenant_repo_uq" ON "core"."github_repositories" USING btree ("tenant_id","repo_id");--> statement-breakpoint
CREATE INDEX "github_repositories_repo_idx" ON "core"."github_repositories" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "github_syncs_repository_idx" ON "core"."github_syncs" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "github_syncs_pending_idx" ON "core"."github_syncs" USING btree ("created_at") WHERE "core"."github_syncs"."status" in ('pending', 'running');--> statement-breakpoint
ALTER TABLE "core"."templates" ADD CONSTRAINT "templates_github_repository_id_github_repositories_id_fk" FOREIGN KEY ("github_repository_id") REFERENCES "core"."github_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_github_path_uq" ON "core"."templates" USING btree ("github_repository_id","path") WHERE "core"."templates"."github_repository_id" is not null;--> statement-breakpoint
CREATE POLICY "github_installations_tenant" ON "core"."github_installations" AS PERMISSIVE FOR ALL TO public USING ("core"."github_installations"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."github_installations"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "github_repositories_tenant" ON "core"."github_repositories" AS PERMISSIVE FOR ALL TO public USING ("core"."github_repositories"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."github_repositories"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "github_syncs_tenant" ON "core"."github_syncs" AS PERMISSIVE FOR ALL TO public USING ("core"."github_syncs"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."github_syncs"."tenant_id" = current_setting('app.tenant_id')::uuid);