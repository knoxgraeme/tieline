CREATE TABLE accounts (
  id BIGINT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE VIEW active_accounts AS
SELECT id, display_name
FROM accounts;

CREATE FUNCTION refresh_accounts()
RETURNS INTEGER
LANGUAGE SQL
AS 'SELECT 1';

CREATE TABLE app.qualified_accounts (
  id BIGINT
);

CREATE VIEW "Quoted View" AS
SELECT id
FROM accounts;

CREATE FUNCTION overloaded(value INTEGER)
RETURNS INTEGER
LANGUAGE SQL
AS 'SELECT 1';

CREATE FUNCTION overloaded(value TEXT)
RETURNS INTEGER
LANGUAGE SQL
AS 'SELECT 2';
