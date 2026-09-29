-- Where each existing template is maintained (#234). Before this column every
-- `tsx` template was an upload, since #160 had no other way to make one, and
-- every `html` template was written in the dash's editor.
UPDATE "core"."templates" SET "source" = 'upload' WHERE "kind" = 'tsx';
