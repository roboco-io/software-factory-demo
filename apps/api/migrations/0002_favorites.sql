CREATE TABLE favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, article_id)
);
CREATE INDEX favorites_article_idx ON favorites (article_id);
