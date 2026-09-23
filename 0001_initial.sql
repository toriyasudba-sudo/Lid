CREATE TABLE IF NOT EXISTS users (
  telegram_user_id TEXT PRIMARY KEY,
  username TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  sessions_count INTEGER NOT NULL DEFAULT 1,
  write_access INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  telegram_user_id TEXT,
  started_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  last_screen TEXT DEFAULT '',
  FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_user_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  telegram_user_id TEXT,
  event TEXT NOT NULL,
  screen TEXT DEFAULT '',
  meta_json TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  delay_hours INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reminders_user_session_delay ON reminders(telegram_user_id, session_id, delay_hours);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
