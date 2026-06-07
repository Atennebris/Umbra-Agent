CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  data TEXT
);

CREATE VIEW active_sessions AS
  SELECT s.id, u.email FROM sessions s
  JOIN users u ON u.id = s.user_id;

CREATE FUNCTION get_user_count() RETURNS INTEGER AS $$
  SELECT COUNT(*) FROM users;
$$ LANGUAGE sql;
