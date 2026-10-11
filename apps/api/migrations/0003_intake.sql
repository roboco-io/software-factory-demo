-- P3 유입(spec 7.1.3): 프로덕션 에러와 익명 피드백. 열·테이블을 지우지 않는다.
CREATE TABLE error_events (
  fingerprint TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  acked_at TEXT
);
CREATE INDEX error_events_last_seen_idx ON error_events (last_seen);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  path TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT
);
CREATE INDEX feedback_ip_created_idx ON feedback (ip_hash, created_at);
CREATE INDEX feedback_pending_idx ON feedback (acked_at, id);
