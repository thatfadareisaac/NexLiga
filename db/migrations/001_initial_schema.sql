CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'email',
  google_sub TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted', 'private')),
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sponsor_name TEXT NOT NULL DEFAULT '',
  sponsor_tagline TEXT NOT NULL DEFAULT '',
  sponsor_url TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_display_name TEXT NOT NULL DEFAULT '',
  banner_pattern TEXT NOT NULL DEFAULT 'floodlights'
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6f56e8',
  created_at TEXT NOT NULL,
  logo_url TEXT NOT NULL DEFAULT '',
  UNIQUE (league_id, name)
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  shirt_number INTEGER,
  position TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  photo_url TEXT NOT NULL DEFAULT '',
  UNIQUE (team_id, name)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  home_team_id TEXT NOT NULL REFERENCES teams(id),
  away_team_id TEXT NOT NULL REFERENCES teams(id),
  matchweek INTEGER NOT NULL,
  kickoff_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'played')),
  home_score INTEGER,
  away_score INTEGER,
  updated_at TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT '',
  CHECK (home_team_id <> away_team_id),
  CHECK (
    (status = 'scheduled' AND home_score IS NULL AND away_score IS NULL)
    OR (status <> 'scheduled' AND home_score IS NOT NULL AND away_score IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS match_squads (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  starting_players TEXT NOT NULL DEFAULT '[]',
  bench_players TEXT NOT NULL DEFAULT '[]',
  is_public INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (match_id, team_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  assist_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL DEFAULT 'goal'
    CHECK (event_type IN ('goal', 'own_goal', 'penalty', 'yellow_card', 'red_card')),
  minute INTEGER NOT NULL,
  added_time INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS league_events (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sponsor_leads (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
  ON users (google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_leagues_owner ON leagues (owner_id);
CREATE INDEX IF NOT EXISTS idx_matches_league ON matches (league_id, matchweek, kickoff_at);
CREATE INDEX IF NOT EXISTS idx_events_league ON league_events (league_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_team_shirt_number
  ON players (team_id, shirt_number) WHERE shirt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_players_team ON players (team_id, name);
CREATE INDEX IF NOT EXISTS idx_match_events_match ON match_events (match_id, minute, added_time);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_squads ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsor_leads ENABLE ROW LEVEL SECURITY;
