#!/bin/sh
set -eu
# Only initial empty cluster. Never print values or use passwords on argv.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv console_password CONSOLE_DB_PASSWORD
\getenv workflow_password WORKFLOW_DB_PASSWORD
\getenv keycloak_password KEYCLOAK_DB_PASSWORD
CREATE ROLE console LOGIN PASSWORD :'console_password';
CREATE ROLE workflow LOGIN PASSWORD :'workflow_password';
CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_password';
CREATE DATABASE console OWNER console;
CREATE DATABASE workflow OWNER workflow;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE CONNECT ON DATABASE console FROM PUBLIC;
REVOKE CONNECT ON DATABASE workflow FROM PUBLIC;
REVOKE CONNECT ON DATABASE keycloak FROM PUBLIC;
GRANT CONNECT ON DATABASE console TO console;
GRANT CONNECT ON DATABASE workflow TO workflow;
GRANT CONNECT ON DATABASE keycloak TO keycloak;
SQL
