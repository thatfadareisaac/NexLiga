import 'dotenv/config';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import nodemailer from 'nodemailer';
import { db, healthCheck, withDatabaseContext } from './db/postgres.mjs';
import {
  ensureMediaBucket,
  mediaOrigin,
  publicMediaUrl,
  storageConfigured,
  uploadMedia,
} from './storage/supabase-storage.mjs';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const SECURE_COOKIE = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleOAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const mailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
        : undefined,
    })
  : null;
const mailFrom = process.env.SMTP_FROM || process.env.SMTP_USER;

const now = () => new Date().toISOString();
const id = () => randomBytes(16).toString('hex');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const slugify = (value) =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52) || 'league';
const send = (res, status, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
};
const fail = (res, status, code, message) => send(res, status, { error: { code, message } });
const cookieValue = (req, name) =>
  (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
const authAttempts = new Map();

async function userFor(req) {
  const token = cookieValue(req, 'fd_session');
  if (!token) return null;
  const session = await db
    .prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?')
    .get(sha(decodeURIComponent(token)), Date.now());
  if (!session) return null;
  return (
    (await db
      .prepare('SELECT id,name,email,created_at,provider FROM users WHERE id=?')
      .get(session.user_id)) || null
  );
}
async function ownerLeague(slug, user, res) {
  if (!user) {
    fail(res, 401, 'sign_in_required', 'Sign in to manage your leagues.');
    return null;
  }
  const league = await db.prepare('SELECT * FROM leagues WHERE slug=?').get(slug);
  if (!league) {
    fail(res, 404, 'not_found', 'League not found.');
    return null;
  }
  if (league.owner_id !== user.id) {
    fail(res, 403, 'owner_only', 'Only the league creator can make changes.');
    return null;
  }
  return league;
}
async function bodyJson(req, max = 65536) {
  let raw = '';
  for await (const part of req) {
    raw += part;
    if (raw.length > max)
      throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Send valid JSON.'), { status: 400 });
  }
}
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function makeSchedule(teams) {
  const list = [...teams];
  if (list.length % 2) list.push(null);
  const rounds = [];
  const n = list.length;
  for (let round = 0; round < n - 1; round++) {
    const games = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i],
        b = list[n - 1 - i];
      if (a && b) games.push(round % 2 ? [b, a] : [a, b]);
    }
    rounds.push(games);
    list.splice(1, 0, list.pop());
  }
  const lastVenue = new Map(),
    homeCount = new Map(),
    gameCount = new Map(),
    firstLeg = rounds.map((games) => {
      let best = games,
        bestCost = Infinity;
      for (let mask = 0; mask < 2 ** games.length; mask++) {
        const candidate = games.map(([a, b], i) => (mask & (1 << i) ? [b, a] : [a, b]));
        let cost = 0;
        for (const [home, away] of candidate) {
          if (lastVenue.get(home) === 'home') cost += 100;
          if (lastVenue.get(away) === 'away') cost += 100;
          for (const [team, homeNow] of [
            [home, true],
            [away, false],
          ]) {
            const homes = (homeCount.get(team) || 0) + (homeNow ? 1 : 0),
              played = (gameCount.get(team) || 0) + 1;
            cost += Math.abs(homes - (played - homes));
          }
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = candidate;
        }
      }
      for (const [home, away] of best) {
        lastVenue.set(home, 'home');
        lastVenue.set(away, 'away');
        homeCount.set(home, (homeCount.get(home) || 0) + 1);
        gameCount.set(home, (gameCount.get(home) || 0) + 1);
        gameCount.set(away, (gameCount.get(away) || 0) + 1);
      }
      return best;
    });
  return [...firstLeg, ...firstLeg.map((games) => games.map(([home, away]) => [away, home]))];
}
async function addMatch(leagueId, homeId, awayId, week, kickoff, venue = '') {
  await db
    .prepare(
      "INSERT INTO matches(id,league_id,home_team_id,away_team_id,matchweek,kickoff_at,venue,status,updated_at) VALUES(?,?,?,?,?,?,?,'scheduled',?)"
    )
    .run(id(), leagueId, homeId, awayId, week, kickoff, venue, now());
}
async function standings(leagueId, includeLive = false) {
  const [teams, games] = await Promise.all([
    db.prepare('SELECT id,name,short_name,color FROM teams WHERE league_id=?').all(leagueId),
    db
      .prepare(
        "SELECT home_team_id,away_team_id,home_score,away_score,status FROM matches WHERE league_id=? AND (status='played' OR (?=1 AND status='live')) ORDER BY kickoff_at"
      )
      .all(leagueId, includeLive ? 1 : 0),
  ]);
  const rows = new Map(
    teams.map((t) => [
      t.id,
      {
        ...t,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        gf: 0,
        ga: 0,
        points: 0,
        form: [],
        liveMatch: false,
      },
    ])
  );
  for (const m of games) {
    const h = rows.get(m.home_team_id),
      a = rows.get(m.away_team_id);
    if (!h || !a) continue;
    const live = m.status === 'live';
    h.liveMatch = h.liveMatch || live;
    a.liveMatch = a.liveMatch || live;
    h.played++;
    a.played++;
    h.gf += m.home_score || 0;
    h.ga += m.away_score || 0;
    a.gf += m.away_score || 0;
    a.ga += m.home_score || 0;
    if (m.home_score > m.away_score) {
      h.won++;
      h.points += 3;
      a.lost++;
      h.form.push('W');
      a.form.push('L');
    } else if (m.home_score < m.away_score) {
      a.won++;
      a.points += 3;
      h.lost++;
      a.form.push('W');
      h.form.push('L');
    } else {
      h.drawn++;
      a.drawn++;
      h.points++;
      a.points++;
      h.form.push('D');
      a.form.push('D');
    }
  }
  return [...rows.values()]
    .map((t) => ({ ...t, gd: t.gf - t.ga, form: t.form.slice(-5) }))
    .sort(
      (a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name)
    )
    .map((t, i) => ({ position: i + 1, ...t }));
}
async function leagueView(league, user) {
  const teamRows = await db
    .prepare('SELECT id,name,short_name,color,logo_url FROM teams WHERE league_id=? ORDER BY name')
    .all(league.id);
  const teamIds = teamRows.map((team) => team.id);
  const [playerRows, matchRows, topScorers] = await Promise.all([
    teamIds.length
      ? db
          .prepare(
            'SELECT id,team_id,name,shirt_number,position,photo_url FROM players WHERE team_id=ANY(?::text[]) ORDER BY shirt_number,name'
          )
          .all(teamIds)
      : [],
    db
      .prepare(
        `SELECT m.id,m.home_team_id,m.away_team_id,m.matchweek,m.kickoff_at,m.venue,m.status,m.home_score,m.away_score,m.updated_at,
    h.name AS home_name,h.short_name AS home_short,h.color AS home_color,
    a.name AS away_name,a.short_name AS away_short,a.color AS away_color
    FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id WHERE m.league_id=? ORDER BY m.kickoff_at`
      )
      .all(league.id),
    db
      .prepare(
        `SELECT p.id,p.name,t.name AS team_name,t.short_name,COUNT(*)::int AS goals FROM match_events e
    JOIN players p ON p.id=e.player_id JOIN teams t ON t.id=e.team_id WHERE t.league_id=? AND e.event_type IN ('goal','penalty')
    GROUP BY p.id,t.name,t.short_name ORDER BY goals DESC,p.name LIMIT 8`
      )
      .all(league.id),
  ]);
  const playerIds = playerRows.map((player) => player.id);
  const matchIds = matchRows.map((match) => match.id);
  const [playedLineups, goalRows, lineups, playerStats, assistStats] = await Promise.all([
    teamIds.length
      ? db
          .prepare(
            "SELECT s.team_id,s.starting_players,s.bench_players FROM match_squads s JOIN matches m ON m.id=s.match_id WHERE s.team_id=ANY(?::text[]) AND m.status='played'"
          )
          .all(teamIds)
      : [],
    matchIds.length
      ? db
          .prepare(
            `SELECT e.id,e.match_id,e.team_id,e.player_id,e.assist_player_id,e.event_type,e.minute,e.added_time,e.created_at,p.name AS player_name,a.name AS assist_name
    FROM match_events e LEFT JOIN players p ON p.id=e.player_id LEFT JOIN players a ON a.id=e.assist_player_id
    WHERE e.match_id=ANY(?::text[]) ORDER BY e.minute,e.added_time,e.created_at`
          )
          .all(matchIds)
      : [],
    matchIds.length
      ? db
          .prepare(
            'SELECT match_id,team_id,starting_players,bench_players,is_public FROM match_squads WHERE match_id=ANY(?::text[])'
          )
          .all(matchIds)
      : [],
    playerIds.length
      ? db
          .prepare(
            `SELECT player_id,
              COUNT(*) FILTER (WHERE event_type IN ('goal','penalty'))::int AS goals,
              COUNT(*) FILTER (WHERE event_type='yellow_card')::int AS yellow_cards,
              COUNT(*) FILTER (WHERE event_type='red_card')::int AS red_cards
            FROM match_events WHERE player_id=ANY(?::text[]) GROUP BY player_id`
          )
          .all(playerIds)
      : [],
    playerIds.length
      ? db
          .prepare(
            'SELECT assist_player_id,COUNT(*)::int AS assists FROM match_events WHERE assist_player_id=ANY(?::text[]) GROUP BY assist_player_id'
          )
          .all(playerIds)
      : [],
  ]);
  const appearances = new Map();
  for (const lineup of playedLineups) {
    const participants = new Set([
      ...JSON.parse(lineup.starting_players),
      ...JSON.parse(lineup.bench_players),
    ]);
    for (const playerId of participants) {
      appearances.set(playerId, (appearances.get(playerId) || 0) + 1);
    }
  }
  const statsByPlayer = new Map(playerStats.map((stats) => [stats.player_id, stats]));
  const assistsByPlayer = new Map(
    assistStats.map((stats) => [stats.assist_player_id, stats.assists])
  );
  const teamsById = new Map(
    teamRows.map((team) => [team.id, { ...team, logoUrl: team.logo_url, players: [] }])
  );
  for (const player of playerRows) {
    const stats = statsByPlayer.get(player.id);
    teamsById.get(player.team_id).players.push({
      ...player,
      photoUrl: player.photo_url,
      stats: {
        goals: stats?.goals || 0,
        assists: assistsByPlayer.get(player.id) || 0,
        yellowCards: stats?.yellow_cards || 0,
        redCards: stats?.red_cards || 0,
        appearances: appearances.get(player.id) || 0,
      },
    });
  }
  const teams = [...teamsById.values()];
  const goalsByMatch = new Map();
  for (const goal of goalRows) {
    const goals = goalsByMatch.get(goal.match_id) || [];
    goals.push(goal);
    goalsByMatch.set(goal.match_id, goals);
  }
  const lineupsByMatch = new Map();
  for (const lineup of lineups) {
    const items = lineupsByMatch.get(lineup.match_id) || [];
    items.push(lineup);
    lineupsByMatch.set(lineup.match_id, items);
  }
  const matches = matchRows.map((match) => {
    match.goals = goalsByMatch.get(match.id) || [];
    match.squads = {};
    for (const lineup of lineupsByMatch.get(match.id) || []) {
      const allowed = lineup.is_public || Boolean(user && league.owner_id === user.id);
      if (!allowed) continue;
      const team = teamsById.get(lineup.team_id);
      if (!team) continue;
      const starters = JSON.parse(lineup.starting_players);
      const bench = JSON.parse(lineup.bench_players);
      const byId = new Map(team.players.map((player) => [player.id, player]));
      match.squads[lineup.team_id] = {
        visible: Boolean(lineup.is_public),
        starting: starters.map((playerId) => byId.get(playerId)).filter(Boolean),
        bench: bench.map((playerId) => byId.get(playerId)).filter(Boolean),
      };
    }
    return match;
  });
  return {
    id: league.id,
    slug: league.slug,
    name: league.name,
    description: league.description,
    visibility: league.visibility,
    logoUrl: league.logo_url,
    ownerDisplayName: league.owner_display_name || '',
    bannerPattern: league.banner_pattern || 'floodlights',
    isDemo: !league.owner_id,
    sponsor: {
      name: league.sponsor_name,
      tagline: league.sponsor_tagline,
      url: league.sponsor_url,
    },
    createdAt: league.created_at,
    updatedAt: league.updated_at,
    canManage: Boolean(user && league.owner_id === user.id),
    teams,
    standings: await standings(league.id),
    liveStandings: await standings(league.id, true),
    matches,
    topScorers,
  };
}
function authRateLimit(key) {
  const t = Date.now(),
    record = authAttempts.get(key) || { count: 0, reset: t + 10 * 60_000 };
  if (t > record.reset) {
    record.count = 0;
    record.reset = t + 10 * 60_000;
  }
  record.count++;
  authAttempts.set(key, record);
  return record.count <= 8;
}
async function setSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  await db
    .prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(sha(token), userId, Date.now() + 14 * 86400_000);
  const secure = SECURE_COOKIE ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `fd_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600${secure}`
  );
}
function clearSession(res) {
  res.setHeader(
    'Set-Cookie',
    `fd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}`
  );
}

async function initializeDatabase() {
  await db.migrate();
  if (storageConfigured()) await ensureMediaBucket();
  if (process.env.NODE_ENV === 'production' && !storageConfigured()) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.');
  }

  await withDatabaseContext(async () => {
    const sampleCount = Number(
      (await db.prepare('SELECT COUNT(*)::int AS count FROM leagues').get()).count
    );
    if (sampleCount === 0 && process.env.NODE_ENV !== 'production') {
      await db.exec('BEGIN');
      try {
        const leagueId = id();
        const created = now();
        const name = 'Harbour Sunday League';
        await db
          .prepare(
            'INSERT INTO leagues(id,slug,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
          )
          .run(
            leagueId,
            'harbour-sunday-league',
            name,
            'A community league where local clubs compete, connect and grow.',
            'public',
            created,
            created
          );
        const clubs = [
          'Harbour Athletic',
          'Northside FC',
          'Riverside Rovers',
          'Old Town United',
          'Greenfield FC',
          'West End Wanderers',
          'Lakeside City',
          'Kingsway Athletic',
        ];
        const colors = [
          '#1769ff',
          '#e25342',
          '#06a77d',
          '#8256d0',
          '#d5901a',
          '#2f7b71',
          '#ba4b80',
          '#526179',
        ];
        const teamIds = [];
        for (const [index, club] of clubs.entries()) {
          const teamId = id();
          await db
            .prepare(
              'INSERT INTO teams(id,league_id,name,short_name,color,created_at) VALUES(?,?,?,?,?,?)'
            )
            .run(
              teamId,
              leagueId,
              club,
              club
                .split(/\s+/)
                .map((part) => part[0])
                .join('')
                .slice(0, 3)
                .toUpperCase(),
              colors[index],
              created
            );
          teamIds.push(teamId);
        }
        const rounds = makeSchedule(teamIds);
        const day = 86400_000;
        const demoScores = [
          [2, 1],
          [1, 1],
          [0, 2],
          [3, 0],
          [1, 0],
          [2, 2],
          [1, 3],
          [0, 1],
        ];
        let gameNumber = 0;
        for (const [weekIndex, games] of rounds.entries()) {
          for (const [matchIndex, pair] of games.entries()) {
            const kickoff = new Date(
              Date.now() +
                (weekIndex < 2
                  ? -(14 - weekIndex * 7 + matchIndex) * day
                  : (weekIndex - 1) * 7 * day + matchIndex * 2 * 3600_000)
            ).toISOString();
            const matchId = id();
            if (gameNumber < demoScores.length) {
              const [homeScore, awayScore] = demoScores[gameNumber];
              await db
                .prepare(
                  `INSERT INTO matches(id,league_id,home_team_id,away_team_id,matchweek,kickoff_at,status,home_score,away_score,updated_at) VALUES(?,?,?,?,?,?,'played',?,?,?)`
                )
                .run(
                  matchId,
                  leagueId,
                  pair[0],
                  pair[1],
                  weekIndex + 1,
                  kickoff,
                  homeScore,
                  awayScore,
                  kickoff
                );
            } else {
              await addMatch(leagueId, pair[0], pair[1], weekIndex + 1, kickoff);
            }
            gameNumber++;
          }
        }
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }

    const leagues = await db.prepare('SELECT id FROM leagues').all();
    for (const league of leagues) {
      const clubs = await db.prepare('SELECT id FROM teams WHERE league_id=?').all(league.id);
      const fixtures = await db
        .prepare(
          'SELECT home_team_id,away_team_id,matchweek,kickoff_at FROM matches WHERE league_id=?'
        )
        .all(league.id);
      const expectedLeg = (clubs.length * (clubs.length - 1)) / 2;
      if (clubs.length > 1 && fixtures.length === expectedLeg) {
        const weeks = Math.max(0, ...fixtures.map((match) => match.matchweek));
        const addReturn = db.prepare(
          "INSERT INTO matches(id,league_id,home_team_id,away_team_id,matchweek,kickoff_at,venue,status,updated_at) VALUES(?,?,?,?,?,?,?,'scheduled',?)"
        );
        for (const match of fixtures) {
          await addReturn.run(
            id(),
            league.id,
            match.away_team_id,
            match.home_team_id,
            weeks + match.matchweek,
            match.kickoff_at
              ? new Date(Date.parse(match.kickoff_at) + weeks * 7 * 86400_000).toISOString()
              : '',
            '',
            now()
          );
        }
      }
    }
  });
}

const leagueUpdateStreams = new Map();
function broadcastLeagueUpdate(slug) {
  const streams = leagueUpdateStreams.get(slug);
  if (!streams) return;
  const payload = 'data: ' + JSON.stringify({ updatedAt: now() }) + '\n\n';
  for (const response of streams) {
    try {
      response.write(payload);
    } catch {
      streams.delete(response);
    }
  }
  if (!streams.size) leagueUpdateStreams.delete(slug);
}
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(),microphone=(),geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: ${mediaOrigin() || ''}; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`
  );
  try {
    const user = await userFor(req);
    if (
      route.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !assertSameOrigin(req)
    )
      return fail(res, 403, 'origin_rejected', 'This request did not come from this NexLiga site.');
    if (route === '/api/health' && req.method === 'GET') {
      await healthCheck();
      return send(res, 200, { ok: true, service: 'NexLiga', storage: 'supabase-postgres' });
    }
    if (route === '/api/auth/config' && req.method === 'GET')
      return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID });
    if (route === '/api/auth/me' && req.method === 'GET')
      return send(res, 200, {
        user: user
          ? { id: user.id, name: user.name, email: user.email, provider: user.provider || 'email' }
          : null,
        leagues: user
          ? Number(
              (
                await db
                  .prepare('SELECT COUNT(*)::int AS count FROM leagues WHERE owner_id=?')
                  .get(user.id)
              ).count
            )
          : 0,
      });
    if (route === '/api/auth/google' && req.method === 'POST') {
      if (!authRateLimit(`google:${req.socket.remoteAddress}`))
        return fail(res, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
      if (!googleOAuthClient)
        return fail(res, 503, 'google_not_configured', 'Google sign-in is not configured yet.');
      const data = await bodyJson(req),
        credential = String(data.credential || '');
      if (!credential || credential.length > 8192)
        return fail(
          res,
          400,
          'invalid_google_credential',
          'Google could not verify this sign-in. Try again.'
        );
      let payload;
      try {
        const ticket = await googleOAuthClient.verifyIdToken({
          idToken: credential,
          audience: GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
      } catch {
        return fail(
          res,
          401,
          'invalid_google_credential',
          'Google could not verify this sign-in. Try again.'
        );
      }
      if (
        !payload?.sub ||
        !payload.email ||
        payload.email_verified !== true ||
        !validEmail(payload.email)
      )
        return fail(
          res,
          401,
          'unverified_google_account',
          'Use a Google account with a verified email address.'
        );
      const email = payload.email.trim().toLowerCase();
      let account = await db
        .prepare('SELECT id,name,email,google_sub FROM users WHERE google_sub=?')
        .get(payload.sub);
      if (!account) {
        account = await db
          .prepare('SELECT id,name,email,google_sub FROM users WHERE email=?')
          .get(email);
        if (account?.google_sub && account.google_sub !== payload.sub)
          return fail(
            res,
            409,
            'google_account_conflict',
            'This email is already connected to a different Google account.'
          );
        if (account) {
          await db
            .prepare("UPDATE users SET google_sub=?,provider='google' WHERE id=?")
            .run(payload.sub, account.id);
        } else {
          const userId = id(),
            salt = randomBytes(16).toString('hex');
          const passwordHash = scryptSync(randomBytes(32), salt, 64).toString('hex');
          const name =
            String(payload.name || email.split('@')[0])
              .trim()
              .slice(0, 70) || email;
          await db
            .prepare(
              "INSERT INTO users(id,name,email,password_hash,created_at,provider,google_sub) VALUES(?,?,?,?,?,'google',?)"
            )
            .run(userId, name, email, `${salt}:${passwordHash}`, now(), payload.sub);
          account = { id: userId, name, email };
        }
      }
      await db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
      await setSession(res, account.id);
      return send(res, 200, {
        user: { id: account.id, name: account.name, email: account.email, provider: 'google' },
      });
    }
    if (route === '/api/auth/forgot-password' && req.method === 'POST') {
      if (!authRateLimit(`forgot:${req.socket.remoteAddress}`))
        return fail(res, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
      if (!mailTransport || !mailFrom)
        return fail(
          res,
          503,
          'email_not_configured',
          'Password recovery is not available yet. Please contact the league administrator.'
        );
      const data = await bodyJson(req),
        email = String(data.email || '')
          .trim()
          .toLowerCase();
      if (!validEmail(email))
        return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
      const userRecord = await db
        .prepare('SELECT id,name,email FROM users WHERE email=?')
        .get(email);
      if (!userRecord)
        return send(res, 200, {
          ok: true,
          message: 'If an account exists, a reset link has been sent.',
        });
      await db.prepare('DELETE FROM password_resets WHERE user_id=?').run(userRecord.id);
      const resetToken = randomBytes(24).toString('hex');
      const resetId = id();
      const expiresAt = Date.now() + 60 * 60 * 1000;
      await db
        .prepare(
          'INSERT INTO password_resets(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)'
        )
        .run(resetId, userRecord.id, sha(resetToken), expiresAt, now());
      const appUrl = (process.env.APP_URL || 'http://127.0.0.1:4173').replace(/\/+$/, '');
      const resetUrl = `${appUrl}/reset-password.html?token=${encodeURIComponent(resetToken)}`;
      await mailTransport.sendMail({
        from: mailFrom,
        to: userRecord.email,
        subject: 'Reset your NexLiga password',
        text: `Hello ${userRecord.name},\n\nUse this link within one hour to reset your NexLiga password:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>Hello ${escapeHtml(userRecord.name)},</p><p>Use the link below within one hour to reset your NexLiga password.</p><p><a href="${escapeHtml(resetUrl)}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
      });
      return send(res, 200, {
        ok: true,
        message: 'If an account exists, a reset link has been sent.',
      });
    }
    if (route === '/api/auth/reset-password' && req.method === 'POST') {
      if (!authRateLimit(`reset:${req.socket.remoteAddress}`))
        return fail(res, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
      const data = await bodyJson(req),
        token = String(data.token || '').trim(),
        password = String(data.password || '');
      if (!token || password.length < 10 || password.length > 200)
        return fail(
          res,
          400,
          'invalid_reset',
          'Use a valid reset token and a password with at least 10 characters.'
        );
      await db.exec('BEGIN');
      try {
        const reset = await db
          .prepare(
            'DELETE FROM password_resets WHERE token_hash=? AND expires_at>? RETURNING user_id'
          )
          .get(sha(token), Date.now());
        if (!reset) {
          await db.exec('COMMIT');
          return fail(res, 400, 'invalid_reset', 'This reset link is invalid or has expired.');
        }
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(password, salt, 64).toString('hex');
        await db
          .prepare('UPDATE users SET password_hash=? WHERE id=?')
          .run(`${salt}:${hash}`, reset.user_id);
        await db.prepare('DELETE FROM password_resets WHERE user_id=?').run(reset.user_id);
        await db.prepare('DELETE FROM sessions WHERE user_id=?').run(reset.user_id);
        await db.exec('COMMIT');
        return send(res, 200, { ok: true, message: 'Password updated successfully.' });
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }
    const liveUpdates = route.match(/^\/api\/leagues\/([a-z0-9-]+)\/live-updates$/);
    if (liveUpdates && req.method === 'GET') {
      const league = await db
        .prepare('SELECT id,slug,visibility,owner_id FROM leagues WHERE slug=?')
        .get(liveUpdates[1]);
      if (!league) return fail(res, 404, 'not_found', 'League not found.');
      if (league.visibility === 'private' && (!user || user.id !== league.owner_id))
        return fail(res, 404, 'not_found', 'League not found.');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      if (!leagueUpdateStreams.has(league.slug)) leagueUpdateStreams.set(league.slug, new Set());
      const streams = leagueUpdateStreams.get(league.slug);
      streams.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': keepalive\n\n');
        } catch {
          clearInterval(heartbeat);
          streams.delete(res);
        }
      }, 25000);
      res.on('close', () => {
        clearInterval(heartbeat);
        streams.delete(res);
        if (!streams.size) leagueUpdateStreams.delete(league.slug);
      });
      return;
    }
    if (route === '/api/auth/register' && req.method === 'POST') {
      if (!authRateLimit(`register:${req.socket.remoteAddress}`))
        return fail(res, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
      const data = await bodyJson(req),
        name = String(data.name || '').trim(),
        email = String(data.email || '')
          .trim()
          .toLowerCase(),
        password = String(data.password || '');
      if (
        name.length < 2 ||
        name.length > 70 ||
        !validEmail(email) ||
        password.length < 10 ||
        password.length > 200
      )
        return fail(
          res,
          400,
          'invalid_registration',
          'Use a name, a valid email, and a password with at least 10 characters.'
        );
      if (await db.prepare('SELECT 1 FROM users WHERE email=?').get(email))
        return fail(
          res,
          409,
          'email_exists',
          'An account already exists for that email. Sign in instead.'
        );
      const uid = id(),
        salt = randomBytes(16).toString('hex'),
        hash = scryptSync(password, salt, 64).toString('hex');
      await db
        .prepare('INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)')
        .run(uid, name, email, `${salt}:${hash}`, now());
      await setSession(res, uid);
      return send(res, 201, { user: { id: uid, name, email } });
    }
    if (route === '/api/auth/login' && req.method === 'POST') {
      if (!authRateLimit(`login:${req.socket.remoteAddress}`))
        return fail(res, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
      const data = await bodyJson(req),
        email = String(data.email || '')
          .trim()
          .toLowerCase(),
        password = String(data.password || '');
      const row = await db
        .prepare('SELECT id,name,email,password_hash FROM users WHERE email=?')
        .get(email);
      let valid = false;
      if (row) {
        const [salt, expected] = row.password_hash.split(':');
        const actual = scryptSync(password, salt, 64);
        valid = timingSafeEqual(actual, Buffer.from(expected, 'hex'));
      }
      if (!valid) return fail(res, 401, 'invalid_credentials', 'Email or password is incorrect.');
      await db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
      await setSession(res, row.id);
      return send(res, 200, { user: { id: row.id, name: row.name, email: row.email } });
    }
    if (route === '/api/auth/logout' && req.method === 'POST') {
      const token = cookieValue(req, 'fd_session');
      if (token)
        await db
          .prepare('DELETE FROM sessions WHERE token_hash=?')
          .run(sha(decodeURIComponent(token)));
      clearSession(res);
      return send(res, 200, { ok: true });
    }
    if (route === '/api/leagues' && req.method === 'GET') {
      const mine = url.searchParams.get('mine') === '1';
      if (mine && !user) return fail(res, 401, 'sign_in_required', 'Sign in to see your leagues.');
      const rows = mine
        ? await db
            .prepare('SELECT * FROM leagues WHERE owner_id=? ORDER BY updated_at DESC')
            .all(user.id)
        : await db
            .prepare(
              "SELECT * FROM leagues WHERE visibility='public' ORDER BY updated_at DESC LIMIT 100"
            )
            .all();
      const leagues = [];
      for (const league of rows) {
        const table = await standings(league.id);
        leagues.push({
          id: league.id,
          slug: league.slug,
          name: league.name,
          description: league.description,
          visibility: league.visibility,
          logoUrl: league.logo_url,
          isDemo: !league.owner_id,
          teamCount: table.length,
          played: table.reduce((total, team) => total + team.played, 0) / 2,
          leader: table[0]?.name || 'Season underway',
          updatedAt: league.updated_at,
          canManage: Boolean(user && league.owner_id === user.id),
        });
      }
      return send(res, 200, {
        leagues,
      });
    }
    const leagueMatch = route.match(/^\/api\/leagues\/([a-z0-9-]+)$/);
    if (leagueMatch && req.method === 'GET') {
      const league = await db.prepare('SELECT * FROM leagues WHERE slug=?').get(leagueMatch[1]);
      if (!league || (league.visibility === 'private' && league.owner_id !== user?.id))
        return fail(res, 404, 'not_found', 'League not found.');
      return send(res, 200, { league: await leagueView(league, user) });
    }
    if (route === '/api/leagues' && req.method === 'POST') {
      if (!user)
        return fail(
          res,
          401,
          'sign_in_required',
          'Create an account or sign in before starting a league.'
        );
      const data = await bodyJson(req),
        name = String(data.name || '').trim(),
        description = String(data.description || '').trim(),
        ownerDisplayName = String(data.ownerDisplayName || '').trim(),
        bannerPattern = String(data.bannerPattern || 'floodlights'),
        clubNames = Array.isArray(data.teams)
          ? data.teams.map((v) => String(v).trim()).filter(Boolean)
          : [];
      const normalized = clubNames.map((s) => s.toLocaleLowerCase());
      if (
        name.length < 3 ||
        name.length > 70 ||
        description.length > 400 ||
        ownerDisplayName.length > 80 ||
        ownerDisplayName.length === 1 ||
        !['floodlights', 'stripes', 'rings', 'pitch', 'dots', 'waves'].includes(bannerPattern) ||
        clubNames.length < 2 ||
        clubNames.length > 24 ||
        clubNames.some((s) => s.length > 50) ||
        new Set(normalized).size !== normalized.length
      )
        return fail(res, 400, 'invalid_league', 'Add a league name and 2–24 unique club names.');
      let slug = slugify(name),
        suffix = 0;
      while (await db.prepare('SELECT 1 FROM leagues WHERE slug=?').get(slug))
        slug = `${slugify(name)}-${++suffix}`;
      const leagueId = id(),
        created = now();
      await db.exec('BEGIN');
      try {
        await db
          .prepare(
            'INSERT INTO leagues(id,slug,name,description,owner_id,owner_display_name,banner_pattern,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
          )
          .run(
            leagueId,
            slug,
            name,
            description,
            user.id,
            ownerDisplayName,
            bannerPattern,
            created,
            created
          );
        const clubs = [];
        for (const [i, club] of clubNames.entries()) {
          const teamId = id(),
            short = club
              .split(/\s+/)
              .map((x) => x[0])
              .join('')
              .slice(0, 3)
              .toUpperCase(),
            palette = [
              '#1769ff',
              '#e25342',
              '#06a77d',
              '#8256d0',
              '#d5901a',
              '#2f7b71',
              '#ba4b80',
              '#526179',
            ];
          await db
            .prepare(
              'INSERT INTO teams(id,league_id,name,short_name,color,created_at) VALUES(?,?,?,?,?,?)'
            )
            .run(teamId, leagueId, club, short, palette[i % palette.length], created);
          clubs.push(teamId);
        }
        const rounds = makeSchedule(clubs);
        for (const [weekIndex, games] of rounds.entries()) {
          for (const [home, away] of games) {
            await addMatch(leagueId, home, away, weekIndex + 1, '');
          }
        }
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
      return send(res, 201, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(leagueId),
          user
        ),
      });
    }
    const manageMatch = route.match(/^\/api\/leagues\/([a-z0-9-]+)\/matches\/([a-f0-9]+)$/);
    if (manageMatch && req.method === 'PATCH') {
      const league = await ownerLeague(manageMatch[1], user, res);
      if (!league) return;
      const match = await db
        .prepare('SELECT * FROM matches WHERE id=? AND league_id=?')
        .get(manageMatch[2], league.id);
      if (!match) return fail(res, 404, 'match_not_found', 'Match not found in this league.');
      const data = await bodyJson(req),
        status = String(data.status || match.status);
      let home = match.home_score ?? 0,
        away = match.away_score ?? 0;
      const kickoff =
          data.kickoffAt === undefined
            ? match.kickoff_at
              ? Date.parse(match.kickoff_at)
              : null
            : data.kickoffAt
              ? Date.parse(data.kickoffAt)
              : null,
        venue = data.venue === undefined ? match.venue : String(data.venue).trim();
      if (!['played', 'live', 'scheduled'].includes(status))
        return fail(res, 400, 'invalid_status', 'Choose upcoming, live, or full time.');
      if (match.status === 'scheduled' && status === 'played')
        return fail(res, 409, 'match_not_live', 'Start the match before marking it full time.');
      if (match.status === 'played' && status !== 'played')
        return fail(
          res,
          409,
          'match_already_finished',
          'A full-time match cannot be returned to live or upcoming.'
        );
      if ((kickoff !== null && !Number.isFinite(kickoff)) || venue.length > 180)
        return fail(
          res,
          400,
          'invalid_fixture',
          'Check the match date and venue (up to 180 characters).'
        );
      const events =
        data.events === undefined ? (data.goals === undefined ? null : data.goals) : data.events;
      if (events !== null && !Array.isArray(events))
        return fail(res, 400, 'invalid_events', 'Match events must be a list.');
      if (status === 'scheduled' && match.status === 'played')
        return fail(
          res,
          409,
          'invalid_status_transition',
          'A concluded match cannot be reset to upcoming.'
        );
      if (events !== null && status === 'scheduled')
        return fail(
          res,
          409,
          'invalid_status_transition',
          'Resetting a live match clears its events; save the reset without event details.'
        );
      const existingEvents = await db
          .prepare('SELECT * FROM match_events WHERE match_id=?')
          .all(match.id),
        existingById = new Map(existingEvents.map((event) => [event.id, event])),
        eventWindow = 24 * 60 * 60 * 1000,
        cutoff = Date.now() - eventWindow;
      if (
        status === 'scheduled' &&
        existingEvents.some((event) => Date.parse(event.created_at) <= cutoff)
      )
        return fail(
          res,
          409,
          'event_locked',
          'This match has events that became permanent more than 24 hours ago, so it cannot be reset.'
        );
      if (events !== null) {
        if (events.length > 100)
          return fail(res, 400, 'invalid_events', 'A match can have at most 100 events.');
        const kept = new Set();
        for (const event of events) {
          const eventId = event.eventId ? String(event.eventId) : null,
            teamId = String(event.teamId || ''),
            playerId = String(event.playerId || ''),
            assistId = event.assistPlayerId ? String(event.assistPlayerId) : null,
            minute = Number(event.minute),
            added = Number(event.addedTime || 0),
            type = String(event.eventType || 'goal');
          if (
            ![match.home_team_id, match.away_team_id].includes(teamId) ||
            !Number.isInteger(minute) ||
            minute < 1 ||
            minute > 120 ||
            !Number.isInteger(added) ||
            added < 0 ||
            added > 20 ||
            !['goal', 'own_goal', 'penalty', 'yellow_card', 'red_card'].includes(type)
          )
            return fail(res, 400, 'invalid_events', 'Check the club, event type and match minute.');
          if (
            !(await db
              .prepare('SELECT 1 FROM players WHERE id=? AND team_id=?')
              .get(playerId, teamId))
          )
            return fail(
              res,
              400,
              'invalid_events',
              'Choose a player from the selected club for each event.'
            );
          if (
            assistId &&
            (!['goal', 'own_goal', 'penalty'].includes(type) ||
              !(await db
                .prepare('SELECT 1 FROM players WHERE id=? AND team_id=?')
                .get(assistId, teamId)))
          )
            return fail(
              res,
              400,
              'invalid_events',
              'Assists must be assigned to a player from the scoring club.'
            );
          if (eventId) {
            const original = existingById.get(eventId);
            if (!original)
              return fail(
                res,
                400,
                'invalid_events',
                'An event no longer belongs to this fixture.'
              );
            if (kept.has(eventId))
              return fail(
                res,
                400,
                'invalid_events',
                'Each match event can only be included once.'
              );
            kept.add(eventId);
            const changed =
              original.team_id !== teamId ||
              original.player_id !== playerId ||
              original.assist_player_id !== (assistId || null) ||
              original.event_type !== type ||
              original.minute !== minute ||
              original.added_time !== added;
            if (changed && Date.parse(original.created_at) <= cutoff)
              return fail(
                res,
                409,
                'event_locked',
                'This event has been final for more than 24 hours and can no longer be changed.'
              );
          } else if (status !== 'live' || match.status !== 'live')
            return fail(
              res,
              409,
              'event_locked',
              'New events can only be added while the match is live.'
            );
        }
        for (const original of existingEvents)
          if (!kept.has(original.id) && Date.parse(original.created_at) <= cutoff)
            return fail(
              res,
              409,
              'event_locked',
              'This event has been final for more than 24 hours and can no longer be removed.'
            );
      }
      const isGoal = (event) =>
        ['goal', 'penalty', 'own_goal'].includes(event.eventType || event.event_type);
      if (status === 'live' && events !== null) {
        const scoringTeam = (event) =>
          (event.eventType || event.event_type) === 'own_goal'
            ? String(event.teamId || event.team_id) === match.home_team_id
              ? match.away_team_id
              : match.home_team_id
            : String(event.teamId || event.team_id);
        home = events.filter(
          (event) => isGoal(event) && scoringTeam(event) === match.home_team_id
        ).length;
        away = events.filter(
          (event) => isGoal(event) && scoringTeam(event) === match.away_team_id
        ).length;
      }
      const resetting = status === 'scheduled',
        homeScore = resetting ? null : home,
        awayScore = resetting ? null : away;
      await db.exec('BEGIN');
      try {
        await db
          .prepare(
            'UPDATE matches SET status=?,home_score=?,away_score=?,kickoff_at=?,venue=?,updated_at=? WHERE id=?'
          )
          .run(
            status,
            homeScore,
            awayScore,
            kickoff === null ? '' : new Date(kickoff).toISOString(),
            venue,
            now(),
            match.id
          );
        if (resetting) await db.prepare('DELETE FROM match_events WHERE match_id=?').run(match.id);
        else if (events !== null) {
          const updateEvent = db.prepare(
              'UPDATE match_events SET team_id=?,player_id=?,assist_player_id=?,event_type=?,minute=?,added_time=? WHERE id=? AND match_id=?'
            ),
            addEvent = db.prepare(
              'INSERT INTO match_events(id,match_id,team_id,player_id,assist_player_id,event_type,minute,added_time,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
            );
          for (const event of events) {
            const values = [
              String(event.teamId),
              String(event.playerId),
              event.assistPlayerId || null,
              event.eventType || 'goal',
              Number(event.minute),
              Number(event.addedTime || 0),
            ];
            if (event.eventId) await updateEvent.run(...values, String(event.eventId), match.id);
            else await addEvent.run(id(), match.id, ...values, now());
          }
          for (const original of existingEvents)
            if (!events.some((event) => event.eventId === original.id))
              await db.prepare('DELETE FROM match_events WHERE id=?').run(original.id);
          if (status === 'played') {
            const finalEvents = events.filter(isGoal),
              scoringTeam = (event) =>
                event.eventType === 'own_goal'
                  ? event.teamId === match.home_team_id
                    ? match.away_team_id
                    : match.home_team_id
                  : event.teamId,
              homeGoals = finalEvents.filter(
                (event) => scoringTeam(event) === match.home_team_id
              ).length,
              awayGoals = finalEvents.filter(
                (event) => scoringTeam(event) === match.away_team_id
              ).length;
            await db
              .prepare('UPDATE matches SET home_score=?,away_score=? WHERE id=?')
              .run(homeGoals, awayGoals, match.id);
          }
        }
        await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
      broadcastLeagueUpdate(league.slug);
      return send(res, 200, { league: await leagueView(league, user) });
    }
    const mediaUpload = route.match(/^\/api\/leagues\/([a-z0-9-]+)\/media$/);
    if (mediaUpload && req.method === 'POST') {
      if (!storageConfigured())
        return fail(res, 503, 'storage_not_configured', 'Image storage is not configured yet.');
      const league = await ownerLeague(mediaUpload[1], user, res);
      if (!league) return;
      const data = await bodyJson(req, 3_000_000),
        kind = String(data.kind || ''),
        entityId = String(data.entityId || '');
      const match = String(data.dataUrl || '').match(
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/
      );
      if (!match) return fail(res, 400, 'invalid_image', 'Choose a PNG, JPEG, or WebP image.');
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length < 16 || bytes.length > 2_000_000)
        return fail(res, 413, 'image_too_large', 'Images must be 2 MB or smaller.');
      const signatures = {
        'image/png': bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG',
        'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
        'image/webp':
          bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
      };
      if (!signatures[match[1]])
        return fail(res, 400, 'invalid_image', 'The image content does not match its file type.');
      let column,
        table,
        idValue = league.id;
      if (kind === 'league') {
        table = 'leagues';
        column = 'logo_url';
      } else if (kind === 'team') {
        table = 'teams';
        column = 'logo_url';
        const target = await db
          .prepare('SELECT id FROM teams WHERE id=? AND league_id=?')
          .get(entityId, league.id);
        if (!target) return fail(res, 404, 'team_not_found', 'Club not found in this league.');
        idValue = target.id;
      } else if (kind === 'player') {
        table = 'players';
        column = 'photo_url';
        const target = await db
          .prepare(
            'SELECT p.id FROM players p JOIN teams t ON t.id=p.team_id WHERE p.id=? AND t.league_id=?'
          )
          .get(entityId, league.id);
        if (!target) return fail(res, 404, 'player_not_found', 'Player not found in this league.');
        idValue = target.id;
      } else
        return fail(
          res,
          400,
          'invalid_media_kind',
          'Choose a league logo, club logo, or player photo.'
        );
      const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].slice(6),
        file = id() + '.' + ext;
      let url;
      try {
        url = await uploadMedia(file, bytes, match[1]);
      } catch (error) {
        console.error('NexLiga image upload failed:', error);
        return fail(res, 502, 'storage_upload_failed', 'The image could not be uploaded.');
      }
      await db.prepare('UPDATE ' + table + ' SET ' + column + '=? WHERE id=?').run(url, idValue);
      await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
      return send(res, 201, {
        url,
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    const manageLineup = route.match(
      /^\/api\/leagues\/([a-z0-9-]+)\/matches\/([a-f0-9]+)\/squads\/([a-f0-9]+)$/
    );
    if (manageLineup && req.method === 'PATCH') {
      const league = await ownerLeague(manageLineup[1], user, res);
      if (!league) return;
      const match = await db
        .prepare('SELECT id,home_team_id,away_team_id FROM matches WHERE id=? AND league_id=?')
        .get(manageLineup[2], league.id);
      if (!match) return fail(res, 404, 'match_not_found', 'Match not found in this league.');
      const teamId = manageLineup[3];
      if (![match.home_team_id, match.away_team_id].includes(teamId))
        return fail(res, 400, 'invalid_team', 'Choose one of the clubs in this fixture.');
      const data = await bodyJson(req),
        starting = Array.isArray(data.startingPlayers) ? data.startingPlayers.map(String) : [],
        bench = Array.isArray(data.benchPlayers) ? data.benchPlayers.map(String) : [],
        visible = Boolean(data.visible);
      if (
        starting.length !== 11 ||
        new Set(starting).size !== 11 ||
        new Set(bench).size !== bench.length ||
        bench.some((pid) => starting.includes(pid))
      )
        return fail(
          res,
          400,
          'invalid_lineup',
          'Choose exactly eleven starters and keep the bench separate.'
        );
      const ids = [...starting, ...bench];
      const validPlayers =
        ids.length <= 30 && ids.length
          ? await db
              .prepare('SELECT id FROM players WHERE team_id=? AND id=ANY(?::text[])')
              .all(teamId, ids)
          : [];
      if (ids.length > 30 || validPlayers.length !== ids.length)
        return fail(res, 400, 'invalid_lineup', 'Every selected player must belong to this club.');
      await db
        .prepare(
          'INSERT INTO match_squads(match_id,team_id,starting_players,bench_players,is_public,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(match_id,team_id) DO UPDATE SET starting_players=excluded.starting_players,bench_players=excluded.bench_players,is_public=excluded.is_public,updated_at=excluded.updated_at'
        )
        .run(
          match.id,
          teamId,
          JSON.stringify(starting),
          JSON.stringify(bench),
          visible ? 1 : 0,
          now()
        );
      await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
      return send(res, 200, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    const partnerCollection = route.match(/^\/api\/leagues\/([a-z0-9-]+)\/partner-inquiries$/);
    if (partnerCollection && req.method === 'POST') {
      if (!authRateLimit(`partner:${req.socket.remoteAddress}`))
        return fail(res, 429, 'rate_limited', 'Too many partnership enquiries. Try again later.');
      const league = await db
        .prepare('SELECT * FROM leagues WHERE slug=?')
        .get(partnerCollection[1]);
      if (!league || league.visibility === 'private')
        return fail(res, 404, 'not_found', 'League not found.');
      const data = await bodyJson(req),
        business = String(data.businessName || '').trim(),
        contact = String(data.contactName || '').trim(),
        email = String(data.email || '')
          .trim()
          .toLowerCase(),
        message = String(data.message || '').trim();
      if (
        business.length < 2 ||
        business.length > 100 ||
        contact.length < 2 ||
        contact.length > 70 ||
        !validEmail(email) ||
        message.length < 10 ||
        message.length > 1000
      )
        return fail(
          res,
          400,
          'invalid_inquiry',
          'Add your business, contact name, valid email, and a short message.'
        );
      await db
        .prepare(
          'INSERT INTO sponsor_leads(id,league_id,business_name,contact_name,email,message,created_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(id(), league.id, business, contact, email, message, now());
      return send(res, 201, {
        ok: true,
        message: 'Thanks. The league manager can now review your partnership enquiry.',
      });
    }
    if (partnerCollection && req.method === 'GET') {
      const league = await ownerLeague(partnerCollection[1], user, res);
      if (!league) return;
      const inquiries = await db
        .prepare(
          'SELECT id,business_name,contact_name,email,message,status,created_at FROM sponsor_leads WHERE league_id=? ORDER BY created_at DESC'
        )
        .all(league.id);
      return send(res, 200, { inquiries });
    }
    const partnerLead = route.match(
      /^\/api\/leagues\/([a-z0-9-]+)\/partner-inquiries\/([a-f0-9]+)$/
    );
    if (partnerLead && req.method === 'PATCH') {
      const league = await ownerLeague(partnerLead[1], user, res);
      if (!league) return;
      const data = await bodyJson(req),
        status = String(data.status || '');
      if (!['new', 'contacted'].includes(status))
        return fail(res, 400, 'invalid_status', 'Choose new or contacted.');
      const result = await db
        .prepare('UPDATE sponsor_leads SET status=? WHERE id=? AND league_id=?')
        .run(status, partnerLead[2], league.id);
      if (!result.changes)
        return fail(res, 404, 'inquiry_not_found', 'Partnership enquiry not found.');
      return send(res, 200, { ok: true });
    }
    const matchCollection = route.match(/^\/api\/leagues\/([a-z0-9-]+)\/matches$/);
    if (matchCollection && req.method === 'POST') {
      const league = await ownerLeague(matchCollection[1], user, res);
      if (!league) return;
      const data = await bodyJson(req),
        teams = await db.prepare('SELECT id,name FROM teams WHERE league_id=?').all(league.id),
        home = teams.find((t) => t.id === data.homeTeamId),
        away = teams.find((t) => t.id === data.awayTeamId),
        week = Number(data.matchweek || 1),
        kickoff = data.kickoffAt ? Date.parse(data.kickoffAt) : null;
      if (
        !home ||
        !away ||
        home.id === away.id ||
        !Number.isInteger(week) ||
        week < 1 ||
        week > 100 ||
        (kickoff !== null && !Number.isFinite(kickoff))
      )
        return fail(
          res,
          400,
          'invalid_fixture',
          'Choose two different clubs and a valid matchweek. Kickoff can be left unconfirmed.'
        );
      const venue = String(data.venue || '').trim();
      if (venue.length > 180)
        return fail(res, 400, 'invalid_fixture', 'Venue must be 180 characters or fewer.');
      await addMatch(
        league.id,
        home.id,
        away.id,
        week,
        kickoff === null ? '' : new Date(kickoff).toISOString(),
        venue
      );
      await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
      return send(res, 201, { league: await leagueView(league, user) });
    }
    const teamCollection = route.match(/^\/api\/leagues\/([a-z0-9-]+)\/teams$/);
    if (teamCollection && req.method === 'POST') {
      const league = await ownerLeague(teamCollection[1], user, res);
      if (!league) return;
      const data = await bodyJson(req),
        name = String(data.name || '').trim();
      if (name.length < 2 || name.length > 50)
        return fail(res, 400, 'invalid_team', 'Club names must be 2 to 50 characters.');
      if (
        await db
          .prepare('SELECT 1 FROM teams WHERE league_id=? AND LOWER(name)=LOWER(?)')
          .get(league.id, name)
      )
        return fail(res, 409, 'team_exists', 'That club is already in this league.');
      if (
        Number(
          (
            await db
              .prepare('SELECT COUNT(*)::int AS count FROM teams WHERE league_id=?')
              .get(league.id)
          ).count
        ) >= 24
      )
        return fail(res, 409, 'team_limit', 'A league can have up to 24 clubs.');
      if (
        await db
          .prepare("SELECT 1 FROM matches WHERE league_id=? AND status!='scheduled' LIMIT 1")
          .get(league.id)
      )
        return fail(
          res,
          409,
          'season_underway',
          'A club can only be added before the season has results, so the full schedule can stay fair.'
        );
      const previous = await db
          .prepare('SELECT id FROM teams WHERE league_id=? ORDER BY created_at,id')
          .all(league.id),
        teamId = id(),
        palette = [
          '#1769ff',
          '#e25342',
          '#06a77d',
          '#8256d0',
          '#d5901a',
          '#2f7b71',
          '#ba4b80',
          '#526179',
        ];
      await db.exec('BEGIN');
      try {
        await db
          .prepare(
            'INSERT INTO teams(id,league_id,name,short_name,color,created_at) VALUES(?,?,?,?,?,?)'
          )
          .run(
            teamId,
            league.id,
            name,
            name
              .split(/\s+/)
              .map((x) => x[0])
              .join('')
              .slice(0, 3)
              .toUpperCase(),
            palette[previous.length % palette.length],
            now()
          );
        const clubs = [...previous.map((t) => t.id), teamId],
          rounds = makeSchedule(clubs);
        await db.prepare('DELETE FROM matches WHERE league_id=?').run(league.id);
        for (const [weekIndex, games] of rounds.entries()) {
          for (const [home, away] of games) {
            await addMatch(league.id, home, away, weekIndex + 1, '');
          }
        }
        await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
      return send(res, 201, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    const bulkPlayers = route.match(
      /^\/api\/leagues\/([a-z0-9-]+)\/teams\/([a-f0-9]+)\/players\/bulk$/
    );
    if (bulkPlayers && req.method === 'POST') {
      const league = await ownerLeague(bulkPlayers[1], user, res);
      if (!league) return;
      const team = await db
        .prepare('SELECT id FROM teams WHERE id=? AND league_id=?')
        .get(bulkPlayers[2], league.id);
      if (!team) return fail(res, 404, 'team_not_found', 'Club not found in this league.');
      const data = await bodyJson(req),
        items = Array.isArray(data.players) ? data.players : [],
        positions = new Set([
          'Goalkeeper',
          'Right Back',
          'Left Back',
          'Centre Back',
          'Wing Back',
          'Defensive Midfielder',
          'Central Midfielder',
          'Attacking Midfielder',
          'Right Winger',
          'Left Winger',
          'Second Striker',
          'Striker',
        ]);
      if (!items.length || items.length > 100)
        return fail(res, 400, 'invalid_players', 'Import between 1 and 100 players at a time.');
      const cleaned = items.map((p) => ({
        name: String(p.name || '').trim(),
        number:
          p.shirtNumber === '' || p.shirtNumber === undefined || p.shirtNumber === null
            ? null
            : Number(p.shirtNumber),
        position: String(p.position || '').trim(),
      }));
      if (
        cleaned.some(
          (p) =>
            p.name.length < 2 ||
            p.name.length > 70 ||
            !(
              p.number === null ||
              (Number.isInteger(p.number) && p.number >= 0 && p.number <= 99)
            ) ||
            !positions.has(p.position)
        )
      )
        return fail(
          res,
          400,
          'invalid_players',
          'Check every name, shirt number, and standard football position.'
        );
      const names = cleaned.map((p) => p.name.toLowerCase()),
        numbers = cleaned.map((p) => p.number).filter((n) => n !== null);
      if (
        new Set(names).size !== names.length ||
        (
          await db
            .prepare('SELECT id FROM players WHERE team_id=? AND LOWER(name)=ANY(?::text[])')
            .all(team.id, names)
        ).length > 0
      )
        return fail(
          res,
          409,
          'player_exists',
          'The import contains a duplicate or a player already on this club list.'
        );
      if (
        new Set(numbers).size !== numbers.length ||
        (numbers.length > 0 &&
          (
            await db
              .prepare('SELECT id FROM players WHERE team_id=? AND shirt_number=ANY(?::int[])')
              .all(team.id, numbers)
          ).length > 0)
      )
        return fail(
          res,
          409,
          'shirt_number_taken',
          'Every shirt number must be unique within the club squad.'
        );
      await db.exec('BEGIN');
      try {
        const insert = db.prepare(
          'INSERT INTO players(id,team_id,name,shirt_number,position,created_at) VALUES(?,?,?,?,?,?)'
        );
        for (const p of cleaned)
          await insert.run(id(), team.id, p.name, p.number, p.position, now());
        await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
      return send(res, 201, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    const teamSettings = route.match(/^\/api\/leagues\/([a-z0-9-]+)\/teams\/([a-f0-9]+)$/);
    if (teamSettings && req.method === 'PATCH') {
      const league = await ownerLeague(teamSettings[1], user, res);
      if (!league) return;
      const team = await db
        .prepare('SELECT * FROM teams WHERE id=? AND league_id=?')
        .get(teamSettings[2], league.id);
      if (!team) return fail(res, 404, 'team_not_found', 'Club not found in this league.');
      const data = await bodyJson(req),
        name = data.name === undefined ? team.name : String(data.name).trim(),
        shortName =
          data.shortName === undefined
            ? team.short_name
            : String(data.shortName).trim().toUpperCase(),
        color = data.color === undefined ? team.color : String(data.color);
      if (
        name.length < 2 ||
        name.length > 50 ||
        shortName.length < 2 ||
        shortName.length > 5 ||
        !/^[A-Z0-9]+$/.test(shortName) ||
        !/^#[0-9a-f]{6}$/i.test(color)
      )
        return fail(
          res,
          400,
          'invalid_team',
          'Check the club name, short name and six-digit color.'
        );
      if (
        await db
          .prepare('SELECT 1 FROM teams WHERE league_id=? AND id<>? AND LOWER(name)=LOWER(?)')
          .get(league.id, team.id, name)
      )
        return fail(res, 409, 'team_exists', 'Another club already uses that name.');
      await db
        .prepare('UPDATE teams SET name=?,short_name=?,color=? WHERE id=?')
        .run(name, shortName, color, team.id);
      await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
      return send(res, 200, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    const playerCollection = route.match(
      /^\/api\/leagues\/([a-z0-9-]+)\/teams\/([a-f0-9]+)\/players$/
    );
    if (playerCollection && req.method === 'POST') {
      const league = await ownerLeague(playerCollection[1], user, res);
      if (!league) return;
      const team = await db
        .prepare('SELECT id FROM teams WHERE id=? AND league_id=?')
        .get(playerCollection[2], league.id);
      if (!team) return fail(res, 404, 'team_not_found', 'Club not found in this league.');
      const data = await bodyJson(req),
        name = String(data.name || '').trim(),
        number =
          data.shirtNumber === '' || data.shirtNumber === undefined
            ? null
            : Number(data.shirtNumber),
        position = String(data.position || '').trim();
      if (
        name.length < 2 ||
        name.length > 70 ||
        !(number === null || (Number.isInteger(number) && number >= 0 && number <= 99)) ||
        !new Set([
          'Goalkeeper',
          'Right Back',
          'Left Back',
          'Centre Back',
          'Wing Back',
          'Defensive Midfielder',
          'Central Midfielder',
          'Attacking Midfielder',
          'Right Winger',
          'Left Winger',
          'Second Striker',
          'Striker',
        ]).has(position)
      )
        return fail(
          res,
          400,
          'invalid_player',
          'Enter a player name, valid shirt number, and standard position.'
        );
      if (
        await db
          .prepare('SELECT 1 FROM players WHERE team_id=? AND LOWER(name)=LOWER(?)')
          .get(team.id, name)
      )
        return fail(res, 409, 'player_exists', 'That player is already on this club list.');
      if (
        number !== null &&
        (await db
          .prepare('SELECT 1 FROM players WHERE team_id=? AND shirt_number=?')
          .get(team.id, number))
      )
        return fail(
          res,
          409,
          'shirt_number_taken',
          'That shirt number is already in use by this club.'
        );
      await db
        .prepare(
          'INSERT INTO players(id,team_id,name,shirt_number,position,created_at) VALUES(?,?,?,?,?,?)'
        )
        .run(id(), team.id, name, number, position, now());
      await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
      return send(res, 201, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    const playerRoute = route.match(
      /^\/api\/leagues\/([a-z0-9-]+)\/teams\/([a-f0-9]+)\/players\/([a-f0-9]+)$/
    );
    if (playerRoute && req.method === 'PATCH') {
      const league = await ownerLeague(playerRoute[1], user, res);
      if (!league) return;
      const player = await db
        .prepare(
          'SELECT p.* FROM players p JOIN teams t ON t.id=p.team_id WHERE p.id=? AND p.team_id=? AND t.league_id=?'
        )
        .get(playerRoute[3], playerRoute[2], league.id);
      if (!player) return fail(res, 404, 'player_not_found', 'Player not found on this club list.');
      const data = await bodyJson(req),
        name = data.name === undefined ? player.name : String(data.name).trim(),
        number =
          data.shirtNumber === undefined
            ? player.shirt_number
            : data.shirtNumber === '' || data.shirtNumber === null
              ? null
              : Number(data.shirtNumber),
        position = data.position === undefined ? player.position : String(data.position).trim(),
        positions = new Set([
          'Goalkeeper',
          'Right Back',
          'Left Back',
          'Centre Back',
          'Wing Back',
          'Defensive Midfielder',
          'Central Midfielder',
          'Attacking Midfielder',
          'Right Winger',
          'Left Winger',
          'Second Striker',
          'Striker',
        ]);
      if (
        name.length < 2 ||
        name.length > 70 ||
        !(number === null || (Number.isInteger(number) && number >= 0 && number <= 99)) ||
        !positions.has(position)
      )
        return fail(
          res,
          400,
          'invalid_player',
          'Check the player name, unique shirt number and standard position.'
        );
      if (
        await db
          .prepare('SELECT 1 FROM players WHERE team_id=? AND id<>? AND LOWER(name)=LOWER(?)')
          .get(player.team_id, player.id, name)
      )
        return fail(res, 409, 'player_exists', 'That player name is already in this club squad.');
      if (
        number !== null &&
        (await db
          .prepare('SELECT 1 FROM players WHERE team_id=? AND id<>? AND shirt_number=?')
          .get(player.team_id, player.id, number))
      )
        return fail(
          res,
          409,
          'shirt_number_taken',
          'That shirt number is already in use by this club.'
        );
      await db
        .prepare('UPDATE players SET name=?,shirt_number=?,position=? WHERE id=?')
        .run(name, number, position, player.id);
      await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
      return send(res, 200, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    if (playerRoute && req.method === 'DELETE') {
      const league = await ownerLeague(playerRoute[1], user, res);
      if (!league) return;
      const result = await db
        .prepare(
          'DELETE FROM players WHERE id=? AND team_id=? AND team_id IN (SELECT id FROM teams WHERE league_id=?)'
        )
        .run(playerRoute[3], playerRoute[2], league.id);
      if (!result.changes)
        return fail(res, 404, 'player_not_found', 'Player not found on this club list.');
      await db.prepare('UPDATE leagues SET updated_at=? WHERE id=?').run(now(), league.id);
      return send(res, 200, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    const settings = route.match(/^\/api\/leagues\/([a-z0-9-]+)$/);
    if (settings && req.method === 'PATCH') {
      const league = await ownerLeague(settings[1], user, res);
      if (!league) return;
      const d = await bodyJson(req),
        name = d.name === undefined ? league.name : String(d.name).trim(),
        description =
          d.description === undefined ? league.description : String(d.description).trim(),
        visibility = d.visibility === undefined ? league.visibility : String(d.visibility),
        ownerDisplayName =
          d.ownerDisplayName === undefined
            ? league.owner_display_name
            : String(d.ownerDisplayName).trim(),
        bannerPattern =
          d.bannerPattern === undefined ? league.banner_pattern : String(d.bannerPattern);
      const sponsorName =
          d.sponsorName === undefined ? league.sponsor_name : String(d.sponsorName).trim(),
        sponsorTagline =
          d.sponsorTagline === undefined ? league.sponsor_tagline : String(d.sponsorTagline).trim(),
        sponsorUrl = d.sponsorUrl === undefined ? league.sponsor_url : String(d.sponsorUrl).trim();
      if (
        name.length < 3 ||
        name.length > 70 ||
        description.length > 400 ||
        ownerDisplayName.length > 80 ||
        ownerDisplayName.length === 1 ||
        !['floodlights', 'stripes', 'rings', 'pitch', 'dots', 'waves'].includes(bannerPattern) ||
        !['public', 'unlisted', 'private'].includes(visibility) ||
        sponsorName.length > 80 ||
        sponsorTagline.length > 160 ||
        sponsorUrl.length > 200
      )
        return fail(
          res,
          400,
          'invalid_settings',
          'Check league name, description, visibility and partner details.'
        );
      if (sponsorUrl) {
        try {
          const u = new URL(sponsorUrl);
          if (!['http:', 'https:'].includes(u.protocol)) throw Error();
        } catch {
          return fail(
            res,
            400,
            'invalid_partner_url',
            'Partner link must begin with https:// or http://.'
          );
        }
      }
      const slug = name === league.name ? league.slug : slugify(name);
      if (
        slug !== league.slug &&
        (await db.prepare('SELECT 1 FROM leagues WHERE slug=?').get(slug))
      )
        return fail(res, 409, 'league_name_taken', 'That league URL is already in use.');
      await db
        .prepare(
          'UPDATE leagues SET slug=?,name=?,description=?,visibility=?,owner_display_name=?,banner_pattern=?,sponsor_name=?,sponsor_tagline=?,sponsor_url=?,updated_at=? WHERE id=?'
        )
        .run(
          slug,
          name,
          description,
          visibility,
          ownerDisplayName,
          bannerPattern,
          sponsorName,
          sponsorTagline,
          sponsorUrl,
          now(),
          league.id
        );
      return send(res, 200, {
        league: await leagueView(
          await db.prepare('SELECT * FROM leagues WHERE id=?').get(league.id),
          user
        ),
      });
    }
    if (settings && req.method === 'DELETE') {
      const league = await ownerLeague(settings[1], user, res);
      if (!league) return;
      await db.prepare('DELETE FROM leagues WHERE id=?').run(league.id);
      return send(res, 200, { ok: true });
    }
    if (route.startsWith('/api/')) return fail(res, 404, 'route_not_found', 'API route not found.');

    const mediaFile = route.match(/^\/media\/([a-f0-9]{32}\.(?:png|jpg|webp))$/);
    if (mediaFile) {
      if (!storageConfigured()) return fail(res, 404, 'not_found', 'Image not found.');
      res.writeHead(302, {
        Location: publicMediaUrl(mediaFile[1]),
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end();
    }
    let filePath;
    if (route === '/') filePath = join(ROOT, 'index.html');
    else if (/^\/leagues\/[a-z0-9-]+\/?$/.test(route)) filePath = join(ROOT, 'leagues.html');
    else if (/^\/products\/(live-draw|fixtures|verifier)\.html$/.test(route))
      filePath = join(ROOT, 'products', route.slice('/products/'.length));
    else if (/^\/(index|leagues|reset-password)\.html$/.test(route))
      filePath = join(ROOT, route.slice(1));
    else if (
      /^\/(app\.css|app\.js|leagues\.js|reset-password\.js|images\/[A-Za-z0-9._-]+\.(?:svg|png|jpg|webp))$/.test(
        route
      )
    )
      filePath = resolve(ROOT, route.slice(1));
    else return fail(res, 404, 'not_found', 'Page not found.');
    if (!filePath.startsWith(ROOT + sep) && filePath !== join(ROOT, 'index.html'))
      return fail(res, 404, 'not_found', 'Page not found.');
    if (!existsSync(filePath)) return fail(res, 404, 'not_found', 'Page not found.');
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    res.writeHead(200, {
      'Content-Type': types[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.status) return fail(res, error.status, 'bad_request', error.message);
    console.error('NexLiga request failed:', error);
    if (!res.headersSent)
      fail(res, 500, 'internal_error', 'Something went wrong. Please try again.');
    else res.end();
  }
}

const server = createServer((req, res) => withDatabaseContext(() => handleRequest(req, res)));

async function start() {
  await initializeDatabase();
  server.listen(PORT, HOST, () => console.log(`NexLiga is running at http://${HOST}:${PORT}`));
}

start().catch((error) => {
  console.error('NexLiga could not start:', error);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => {
      db.close().then(
        () => process.exit(0),
        (error) => {
          console.error('NexLiga could not close the database pool:', error);
          process.exit(1);
        }
      );
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
