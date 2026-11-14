-- Folders become rows (template_folders). Every distinct folder label a
-- workspace's templates carry becomes one folder of that name, and each
-- template is filed in it. Agreed with the user 2026-10-01.
INSERT INTO "core"."template_folders" ("tenant_id", "name")
SELECT DISTINCT "tenant_id", btrim("folder")
FROM "core"."templates"
WHERE "folder" IS NOT NULL AND btrim("folder") <> ''
ON CONFLICT ("tenant_id", "name") DO NOTHING;--> statement-breakpoint
UPDATE "core"."templates" AS t
SET "folder_id" = f."id"
FROM "core"."template_folders" AS f
WHERE f."tenant_id" = t."tenant_id"
  AND f."name" = btrim(t."folder")
  AND t."folder_id" IS NULL;
