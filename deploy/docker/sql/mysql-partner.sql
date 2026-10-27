-- Development partner-portal user table in MySQL (the "Partner portal MySQL" store in identity.dev.yaml).
-- Password: Northwind-Dev-Password-4. Development only.
CREATE TABLE IF NOT EXISTS users (
  id        int AUTO_INCREMENT PRIMARY KEY,
  username  varchar(100) NOT NULL UNIQUE,
  pass_hash varchar(255) NOT NULL,
  name      varchar(200) NOT NULL,
  roles     varchar(500) NOT NULL DEFAULT ''
) CHARACTER SET utf8mb4;
INSERT IGNORE INTO users (username, pass_hash, name, roles) VALUES
  ('partner1', '$2b$12$BiuObMLy.vA2cdQia.y4rug4c8sT1iNgAm06SAH3EniiTmTU8hzaq', 'Partner One', 'partners');
CREATE USER IF NOT EXISTS 'portal_readonly'@'%' IDENTIFIED BY 'portal_readonly_dev';
GRANT SELECT ON portal.users TO 'portal_readonly'@'%';
