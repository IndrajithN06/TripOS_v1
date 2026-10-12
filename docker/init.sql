-- Local development only. Creates the NON-superuser role the API connects as,
-- so PostgreSQL row-level security is actually enforced (superusers bypass RLS).
CREATE ROLE tripos_app LOGIN PASSWORD 'tripos_app_dev_only' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE tripos TO tripos_app;
