-- Development HR user table in PostgreSQL (the "HR PostgreSQL" store in identity.dev.yaml).
-- Password for both rows: Northwind-Dev-Password-3. Development only.
CREATE TABLE IF NOT EXISTS staff (
  staff_id     serial PRIMARY KEY,
  login        varchar(100) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  full_name    varchar(200) NOT NULL,
  email        varchar(320),
  is_disabled  boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS staff_groups (staff_id int NOT NULL REFERENCES staff(staff_id), group_name varchar(200) NOT NULL);
INSERT INTO staff (login, password_hash, full_name, email) VALUES
  ('apatel', '$2b$12$XPe0IgVPuesdhI7lP7MD7etZ5H83tDI0fKShMfjyPtE/BiiC.bU0e', 'Asha Patel', 'apatel@northwind.local'),
  ('rkim',   '$2b$12$XPe0IgVPuesdhI7lP7MD7etZ5H83tDI0fKShMfjyPtE/BiiC.bU0e', 'Rae Kim', 'rkim@northwind.local')
ON CONFLICT DO NOTHING;
INSERT INTO staff_groups VALUES (1, 'finance'), (2, 'people');
-- The store connects as a read-only account.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hr_readonly') THEN CREATE ROLE hr_readonly LOGIN PASSWORD 'hr_readonly_dev'; END IF;
END $$;
GRANT SELECT ON staff, staff_groups TO hr_readonly;
