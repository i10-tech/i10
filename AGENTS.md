# Agent rules for i10

## Database and Redis

Before you write or review any change that touches the database or Redis, load
the `db-guard` skill (`.agents/skills/db-guard/SKILL.md`) and follow it. That
covers schema, migrations, queries in TypeScript or Go, SQL functions, triggers,
RLS policies, roles and grants, indexes, connection pools, and Redis keys. The
PR must carry the evidence the skill asks for.
