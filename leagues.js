(() => {
  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const icon = (size = 14) =>
    `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>`;
  let slug = location.pathname.match(/^\/leagues\/([a-z0-9-]+)/)?.[1];
  const directory = byId('leagueDirectory'),
    detail = byId('leagueDetail');
  let account = null,
    activeLeague = null,
    pendingCreate = false,
    liveUpdates = null,
    liveUpdateSlug = null;
  const PLAYER_PAGE_SIZE = 12;
  let playerDirectoryPage = 0,
    previousPlayerQuery = '';
  function renderSearchablePlayers() {
    if (!activeLeague) return;
    const query = byId('playerSearchInput').value.trim().toLowerCase();
    byId('clearPlayerSearch').hidden = !query;
    if (query !== previousPlayerQuery) {
      playerDirectoryPage = 0;
      previousPlayerQuery = query;
    }
    const all = activeLeague.teams.flatMap((team) =>
      team.players.map((player) => ({ team, player }))
    );
    const score = ({ player }) =>
      (player.stats?.goals || 0) * 4 +
      (player.stats?.assists || 0) * 3 +
      (player.stats?.appearances || 0);
    const matches = query
      ? all
          .filter(({ team, player }) =>
            [player.name, player.position, team.name, team.short_name].some((value) =>
              String(value || '')
                .toLowerCase()
                .includes(query)
            )
          )
          .sort((a, b) => score(b) - score(a) || a.player.name.localeCompare(b.player.name))
      : all
          .filter((item) => score(item) > 0)
          .sort((a, b) => score(b) - score(a) || a.player.name.localeCompare(b.player.name))
          .slice(0, 8);
    const pageCount = Math.ceil(matches.length / PLAYER_PAGE_SIZE);
    playerDirectoryPage = Math.min(playerDirectoryPage, Math.max(0, pageCount - 1));
    const start = playerDirectoryPage * PLAYER_PAGE_SIZE;
    const visibleMatches = matches.slice(start, start + PLAYER_PAGE_SIZE);
    byId('playerDirectoryCount').textContent = query
      ? matches.length + ' ' + (matches.length === 1 ? 'match' : 'matches')
      : matches.length + ' top performers';
    if (!matches.length) {
      byId('playerDirectory').innerHTML = query
        ? '<div class="empty-state">No players match that search. Try a name, club or position.</div>'
        : '<div class="empty-state">Player leaders will appear as match stats are recorded. Search above to find any player in the league.</div>';
      return;
    }
    const pagination =
      pageCount > 1
        ? '<nav class="player-directory-pagination" aria-label="Player results pages"><span>Showing ' +
          (start + 1) +
          '–' +
          Math.min(start + PLAYER_PAGE_SIZE, matches.length) +
          ' of ' +
          matches.length +
          '</span><div><button type="button" data-player-page="-1"' +
          (playerDirectoryPage === 0 ? ' disabled' : '') +
          ' aria-label="Previous player results">Previous</button><button type="button" data-player-page="1"' +
          (playerDirectoryPage === pageCount - 1 ? ' disabled' : '') +
          ' aria-label="Next player results">Next</button></div></nav>'
        : '';
    byId('playerDirectory').innerHTML =
      visibleMatches
        .map(
          ({ team, player }) =>
            '<article class="player-spotlight player-result-card">' +
            (player.photoUrl
              ? '<img src="' + escapeHtml(player.photoUrl) + '" alt="">'
              : '<span class="player-mini-avatar">' +
                escapeHtml(player.name.slice(0, 1).toUpperCase()) +
                '</span>') +
            '<div>' +
            playerName(player) +
            '<small>' +
            escapeHtml(team.name) +
            ' · ' +
            escapeHtml(player.position || 'Player') +
            '</small></div><span class="player-result-stats"><b>' +
            Number(player.stats?.goals || 0) +
            '<small>G</small></b><b>' +
            Number(player.stats?.assists || 0) +
            '<small>A</small></b><b>' +
            Number(player.stats?.appearances || 0) +
            '<small>Apps</small></b></span></article>'
        )
        .join('') + pagination;
  }

  const openModal = (id) => byId(id)?.classList.add('open');
  const closeModal = (el) => el?.classList.remove('open');
  let pendingDelete = null;
  function confirmWithUndo(message, action) {
    if (pendingDelete) {
      fdToast('Finish the pending delete action first.');
      return false;
    }
    if (!confirm(message)) return false;
    const notice = document.createElement('div');
    notice.className = 'delete-undo-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.innerHTML =
      '<span>Deleting in <strong>5</strong> seconds.</span><button type="button">Undo</button>';
    document.body.append(notice);
    let seconds = 5;
    const timer = setInterval(() => {
      seconds--;
      const count = notice.querySelector('strong');
      if (count) count.textContent = String(seconds);
    }, 1000);
    const timeout = setTimeout(async () => {
      clearInterval(timer);
      notice.remove();
      pendingDelete = null;
      await action();
    }, 5000);
    notice.querySelector('button').onclick = () => {
      clearTimeout(timeout);
      clearInterval(timer);
      notice.remove();
      pendingDelete = null;
      fdToast('Delete cancelled.');
    };
    pendingDelete = { timeout, timer, notice };
    return true;
  }
  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-modal]');
    if (close) closeModal(close.closest('.modal-backdrop'));
    if (event.target.classList?.contains('modal-backdrop') && event.target.id !== 'accountModal')
      closeModal(event.target);
    if (event.target.closest('[data-auth-open]')) {
      document.querySelector('#accountModal [data-mode="login"]')?.click();
      openModal('accountModal');
    }
  });
  async function loadAccount() {
    try {
      account = (await fdApi('/api/auth/me')).user;
    } catch {
      account = null;
    }
    const signIn = byId('leagueManagerSignIn');
    if (signIn) signIn.hidden = Boolean(account);
  }
  function formatDate(value) {
    if (!value) return 'TBD';
    const date = new Date(value);
    return Number.isNaN(+date)
      ? 'TBD'
      : new Intl.DateTimeFormat(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }).format(date);
  }
  function formatTime(value) {
    if (!value) return 'TBD';
    const date = new Date(value);
    return Number.isNaN(+date)
      ? 'TBD'
      : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  function formDots(form) {
    return `<span class="form-dots">${form.map((r) => `<i class="${r === 'W' ? 'w' : r === 'L' ? 'l' : 'draw'}">${r}</i>`).join('')}</span>`;
  }
  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve('');
      if (file.size > 2_000_000) return reject(new Error('Images must be 2 MB or smaller.'));
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read this image.'));
      reader.readAsDataURL(file);
    });
  }
  async function uploadImage(kind, entityId, file) {
    if (!file) return null;
    const dataUrl = await readImage(file);
    return fdApi(`/api/leagues/${activeLeague.slug}/media`, {
      method: 'POST',
      body: JSON.stringify({ kind, entityId, dataUrl }),
    });
  }
  function playerName(player, classes = '') {
    return `<button type="button" class="player-profile-trigger ${classes}" data-player-profile="${player.id}">${escapeHtml(player.name)}</button>`;
  }
  function renderStatLeaders(kind = 'goals') {
    if (!activeLeague) return;
    const rows = activeLeague.teams
      .flatMap((team) =>
        team.players.map((player) => ({ player, team, value: player.stats?.[kind] || 0 }))
      )
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value || a.player.name.localeCompare(b.player.name))
      .slice(0, 8);
    const label =
      {
        goals: 'Goals',
        assists: 'Assists',
        appearances: 'Appearances',
        yellowCards: 'Yellow cards',
        redCards: 'Red cards',
      }[kind] || 'Stats';
    byId('topScorers').innerHTML = rows.length
      ? rows
          .map(
            (r, i) =>
              `<div class="scorer-row"><span>${i + 1}</span>${playerName(r.player)}<small>${escapeHtml(r.team.name)}</small><b>${r.value}</b></div>`
          )
          .join('')
      : `<div class="empty-state">${label} will appear here as match events are recorded.</div>`;
  }
  function renderPlayerDirectory() {
    if (!activeLeague) return;
    const view = detail.dataset.view,
      section = byId('playersSection'),
      title = section.querySelector('h2'),
      eyebrow = section.querySelector('.eyebrow');
    if (view === 'players') {
      title.textContent = 'Players';
      eyebrow.textContent = 'Top performers · Search every squad';
      renderSearchablePlayers();
      return;
    }
    if (view !== 'table' && view !== 'stats') return;
    if (view === 'table' || view === 'stats') {
      const featured = activeLeague.teams
        .flatMap((team) => team.players.map((player) => ({ team, player })))
        .sort(
          (a, b) =>
            (b.player.stats?.goals || 0) - (a.player.stats?.goals || 0) ||
            (b.player.stats?.assists || 0) - (a.player.stats?.assists || 0)
        )
        .slice(0, 4);
      title.textContent = 'Players to watch';
      eyebrow.textContent = 'Season leaders';
      byId('playerDirectoryCount').textContent = `${featured.length} featured`;
      byId('playerDirectory').innerHTML = featured.length
        ? featured
            .map(
              ({ team, player }) =>
                `<article class="player-spotlight">${player.photoUrl ? `<img src="${escapeHtml(player.photoUrl)}" alt="">` : `<span class="player-mini-avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>`}<div>${playerName(player)}<small>${escapeHtml(team.name)} · ${escapeHtml(player.position || 'Player')}</small></div><strong>${player.stats?.goals || 0}<small>G</small></strong></article>`
            )
            .join('')
        : '<div class="empty-state">Player profiles will appear here when squads are added.</div>';
      return;
    }
  }
  function renderClubDirectory() {
    if (!activeLeague) return;
    byId('clubDirectory').innerHTML = activeLeague.teams
      .map(
        (team) =>
          `<button type="button" class="club-badge-card" data-team-profile="${team.id}" aria-label="View ${escapeHtml(team.name)} club"><span class="club-badge-logo${team.logoUrl ? ' has-logo' : ''}" style="--team-color:${escapeHtml(team.color)}">${team.logoUrl ? `<img src="${escapeHtml(team.logoUrl)}" alt="">` : escapeHtml(team.short_name)}</span><span>${escapeHtml(team.name)}</span></button>`
      )
      .join('');
  }
  function renderLeagues(items, target) {
    target.innerHTML = items.length
      ? items
          .map(
            (l) =>
              `<a class="league-tile" href="/leagues/${encodeURIComponent(l.slug)}"><div class="tile-top"><span class="tile-mark">${
                l.logoUrl
                  ? `<img src="${escapeHtml(l.logoUrl)}" alt="">`
                  : escapeHtml(
                      l.name
                        .split(/\s+/)
                        .map((w) => w[0])
                        .join('')
                        .slice(0, 2)
                        .toUpperCase()
                    )
              }</span><span class="tile-arrow">${icon(16)}</span></div><span class="eyebrow">${l.isDemo ? 'Sample data · ' : ''}${escapeHtml(l.visibility || 'public')} league · ${l.teamCount} clubs</span><h3>${escapeHtml(l.name)}</h3><p>${escapeHtml(l.description || 'A local football community, connected.')}</p><div class="tile-footer"><span>${escapeHtml(l.leader || 'Season underway')}</span><strong>${l.played} matches played</strong></div></a>`
          )
          .join('')
      : '<div class="empty-state">No leagues here yet. Create one and give your community a home.</div>';
  }
  async function loadDirectory() {
    directory.hidden = false;
    detail.hidden = true;
    try {
      const { leagues } = await fdApi('/api/leagues');
      byId('publicCount').textContent =
        `${leagues.length} ${leagues.length === 1 ? 'league' : 'leagues'}`;
      renderLeagues(leagues, byId('publicLeagues'));
      if (account) {
        try {
          const { leagues: owned } = await fdApi('/api/leagues?mine=1');
          byId('ownedSection').hidden = false;
          byId('ownedCount').textContent = `${owned.length} managed`;
          renderLeagues(owned, byId('ownedLeagues'));
        } catch (error) {
          if (error.status === 401) account = null;
        }
      }
    } catch (error) {
      byId('publicLeagues').innerHTML =
        `<div class="empty-state">${escapeHtml(error.message)}<br>Start NexLiga with <code>node server.mjs</code> to connect to the league server.</div>`;
    }
  }
  function renderFixture(match) {
    const home = activeLeague.teams.find((t) => t.id === match.home_team_id),
      away = activeLeague.teams.find((t) => t.id === match.away_team_id),
      scheduled = match.status === 'scheduled';
    const crest = (team) =>
      team?.logoUrl
        ? `<span class="fixture-crest has-logo"><img src="${escapeHtml(team.logoUrl)}" alt=""></span>`
        : `<span class="fixture-crest${team?.logoUrl ? ' has-logo' : ''}" style="--team-color:${escapeHtml(team?.color || '#6556d9')}">${escapeHtml(team?.short_name || 'FC')}</span>`;
    const side = (team, name, score) =>
      `<span class="fixture-side">${crest(team)}<span>${escapeHtml(name)}</span>${!scheduled ? `<b>${score}</b>` : ''}</span>`;
    const kickoff = match.kickoff_at ? new Date(match.kickoff_at) : null;
    const date =
      kickoff && !Number.isNaN(kickoff.valueOf())
        ? kickoff.toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          })
        : 'Date TBD';
    const time = match.kickoff_at ? formatTime(match.kickoff_at) : 'Time TBD';
    const venue = match.venue || 'Venue TBD';
    const status = match.status === 'live' ? 'LIVE' : match.status === 'played' ? 'FT' : 'UPCOMING';
    return `<button type="button" class="league-fixture match-open" data-match-open="${match.id}" aria-label="${escapeHtml(nameOf(match.home_name))} vs ${escapeHtml(nameOf(match.away_name))}"><span class="fixture-teams">${side(home, match.home_name, match.home_score)}${side(away, match.away_name, match.away_score)}</span><span class="fixture-kickoff"><strong>${escapeHtml(date)}</strong><span>${escapeHtml(time)}</span><small>${escapeHtml(venue)}</small><small class="fixture-status ${match.status === 'live' ? 'is-live' : ''}">${status}</small></span></button>`;
  }
  function nameOf(value) {
    return value || 'Team';
  }
  function fixtureGroup(fixtures) {
    const groups = new Map();
    fixtures.forEach((match) => {
      const key = match.matchweek || 1;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(match);
    });
    const total = Math.max(1, ...activeLeague.matches.map((m) => Number(m.matchweek) || 1));
    return [...groups]
      .map(
        ([week, matches]) =>
          `<section class="fixture-matchweek"><h4>Matchday ${week} of ${total}</h4><div class="fixture-matchweek-grid">${matches.map(renderFixture).join('')}</div></section>`
      )
      .join('');
  }
  function renderLiveMatches() {
    if (!activeLeague) return;
    let matches = activeLeague.matches
      .filter((match) => match.status === 'live')
      .sort(
        (a, b) =>
          a.matchweek - b.matchweek || (a.kickoff_at || '').localeCompare(b.kickoff_at || '')
      );
    if (detail.dataset.view === 'overview') matches = matches.slice(0, 2);
    byId('liveMatchesSection').hidden = !matches.length;
    byId('liveMatchList').innerHTML = matches.length ? fixtureGroup(matches) : '';
  }
  function renderUpcomingWeek() {
    const list = byId('upcomingList');
    if (!activeLeague) return;
    const week = Number(byId('publicFixtureWeek').value);
    let fixtures = activeLeague.matches
      .filter((m) => m.status === 'scheduled' && (!week || m.matchweek === week))
      .sort((a, b) => (a.kickoff_at || '').localeCompare(b.kickoff_at || ''));
    if (detail.dataset.view === 'overview') fixtures = fixtures.slice(0, 4);
    list.innerHTML = fixtures.length
      ? fixtureGroup(fixtures)
      : '<div class="empty-state">No fixtures scheduled for this matchweek.</div>';
  }
  function renderTableRows() {
    if (!activeLeague) return;
    const hasLive = activeLeague.matches.some((match) => match.status === 'live');
    let rows = hasLive
      ? activeLeague.liveStandings || activeLeague.standings
      : activeLeague.standings;
    byId('liveTableNotice').hidden = !hasLive;
    if (detail.dataset.view === 'overview') rows = rows.slice(0, 4);
    else if (detail.dataset.view === 'matches' || detail.dataset.view === 'stats')
      rows = rows.slice(0, 5);
    byId('tableBody').innerHTML =
      rows
        .map((team) => {
          const club = activeLeague.teams.find((t) => t.id === team.id);
          return (
            '<tr class="' +
            (team.liveMatch ? 'is-live-table-team' : '') +
            '"><td>' +
            String(team.position).padStart(2, '0') +
            '</td><td><button class="team-profile-trigger" type="button" data-team-profile="' +
            team.id +
            '" aria-label="View ' +
            escapeHtml(team.name) +
            ' club profile"><span class="team-name"><span class="team-crest' +
            (club?.logoUrl ? ' has-logo' : '') +
            '" style="--team-color:' +
            escapeHtml(team.color) +
            '">' +
            (club?.logoUrl
              ? '<img src="' + escapeHtml(club.logoUrl) + '" alt="">'
              : escapeHtml(team.short_name)) +
            '</span>' +
            escapeHtml(team.name) +
            (team.liveMatch ? '<small class="team-live-tag">LIVE</small>' : '') +
            '</span></button></td><td>' +
            team.played +
            '</td><td>' +
            team.won +
            '</td><td>' +
            team.drawn +
            '</td><td>' +
            team.lost +
            '</td><td>' +
            (team.gd > 0 ? '+' : '') +
            team.gd +
            '</td><td><strong>' +
            team.points +
            '</strong></td><td>' +
            formDots(team.form) +
            '</td></tr>'
          );
        })
        .join('') || '<tr><td colspan="9">Add clubs to build the table.</td></tr>';
  }
  function renderResults() {
    if (!activeLeague) return;
    let results = activeLeague.matches
      .filter((m) => m.status === 'played')
      .sort(
        (a, b) =>
          b.matchweek - a.matchweek || (b.kickoff_at || '').localeCompare(a.kickoff_at || '')
      );
    if (detail.dataset.view === 'overview') results = results.slice(0, 4);
    else results = results.slice(0, 10);
    byId('resultsList').innerHTML = results.length
      ? fixtureGroup(results)
      : '<div class="empty-state">No completed results yet. Follow the live matches above.</div>';
  }
  function setLeagueView(view) {
    const allowed = ['overview', 'matches', 'table', 'stats', 'players'];
    if (!allowed.includes(view)) return;
    detail.dataset.view = view;
    document.querySelectorAll('[data-league-nav]').forEach((link) => {
      const current = link.dataset.leagueNav === view;
      link.classList.toggle('active', current);
      if (current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    renderTableRows();
    renderLiveMatches();
    renderUpcomingWeek();
    renderResults();
    renderStatLeaders(
      document.querySelector('[data-stat-kind].active')?.dataset.statKind || 'goals'
    );
    renderPlayerDirectory();
  }
  function renderDetail(league) {
    activeLeague = league;
    directory.hidden = true;
    detail.hidden = false;
    const requestedView = location.hash.slice(1);
    if (['overview', 'matches', 'table', 'stats', 'players'].includes(requestedView))
      detail.dataset.view = requestedView;
    byId('leagueTitle').textContent = league.name;
    byId('leagueDescription').textContent =
      league.description ||
      'Welcome to the league. Follow the table, fixtures and matchday updates here.';
    const leagueLogo = byId('leagueLogo');
    leagueLogo.src = league.logoUrl || '';
    leagueLogo.hidden = !league.logoUrl;
    byId('leagueVisibility').textContent =
      league.visibility === 'unlisted'
        ? 'Unlisted league'
        : league.visibility === 'private'
          ? 'Private league'
          : 'Public league';
    byId('leagueKicker').textContent =
      `${league.isDemo ? 'Sample demo season ? ' : ''}${league.visibility === 'public' ? 'Community' : league.visibility === 'unlisted' ? 'Unlisted' : 'Private'} league ? ${league.teams.length} clubs`;
    const organizer = league.ownerDisplayName || 'League owner';
    byId('ownerCredit').textContent = league.ownerDisplayName
      ? 'Official organizer: ' + organizer
      : 'Community league';
    byId('leagueSeasonBanner').dataset.pattern = league.bannerPattern || 'floodlights';
    const owner = league.canManage;
    document
      .querySelectorAll('.owner-only')
      .forEach((el) => el.classList.toggle('is-owner', owner));
    document
      .querySelectorAll('.owner-inline')
      .forEach((el) => el.classList.toggle('is-owner', owner));
    const complete = league.matches.filter((m) => m.status === 'played').length,
      upcoming = league.matches.filter((m) => m.status === 'scheduled').length;
    byId('clubCount').textContent = league.teams.length;
    byId('leagueClubCountMark').textContent = String(league.teams.length);
    byId('matchCount').textContent = complete;
    byId('nextMatchCount').textContent = upcoming;
    byId('activeManager').textContent = organizer;
    renderTableRows();
    const sorted = [...league.matches].sort(
      (a, b) => a.matchweek - b.matchweek || (a.kickoff_at || '').localeCompare(b.kickoff_at || '')
    );
    const next = sorted.filter((m) => m.status === 'scheduled');
    const weeks = [...new Set(next.map((m) => m.matchweek))].sort((a, b) => a - b);
    const weekSelect = byId('publicFixtureWeek');
    weekSelect.innerHTML = weeks.map((w) => `<option value="${w}">${w}</option>`).join('');
    weekSelect.hidden = !weeks.length;
    if (weeks.length) {
      const firstUpcoming = next.find((m) => m.kickoff_at && new Date(m.kickoff_at) > new Date());
      weekSelect.value = String(firstUpcoming?.matchweek || weeks[0]);
    }
    renderUpcomingWeek();
    renderResults();

    renderStatLeaders(
      document.querySelector('[data-stat-kind].active')?.dataset.statKind || 'goals'
    );
    renderPlayerDirectory();
    renderClubDirectory();
    const sponsorLink = byId('sponsorLink');
    sponsorLink.href = '#';
    sponsorLink.target = '';
    sponsorLink.rel = '';
    if (league.sponsor?.name) {
      byId('sponsorName').textContent = league.sponsor.name;
      byId('sponsorTagline').textContent =
        league.sponsor.tagline || 'Proud to back this football community.';
      if (league.sponsor.url) {
        sponsorLink.textContent = 'Visit community partner ?';
        sponsorLink.href = league.sponsor.url;
        sponsorLink.target = '_blank';
        sponsorLink.rel = 'noopener noreferrer';
      } else sponsorLink.textContent = 'Send a partnership enquiry ?';
    } else {
      byId('sponsorName').textContent = 'Be the reason they play.';
      byId('sponsorTagline').textContent =
        'Support local football and connect your brand with the people who make the game.';
      sponsorLink.textContent = owner ? 'Set up partner placement ?' : 'Partner with this league ?';
    }
    if (owner) loadPartnerInquiries();
    else byId('partnerInquiries').innerHTML = '';
    setLeagueView(detail.dataset.view || 'overview');
    document.title = `${league.name} | NexLiga`;
  }
  async function loadPartnerInquiries() {
    try {
      const { inquiries } = await fdApi(`/api/leagues/${activeLeague.slug}/partner-inquiries`);
      byId('partnerInquiries').innerHTML = inquiries.length
        ? inquiries
            .map(
              (i) =>
                `<article class="partner-inquiry"><div><strong>${escapeHtml(i.business_name)}</strong><span class="inquiry-status ${i.status}">${i.status === 'new' ? 'New' : 'Contacted'}</span></div><a href="mailto:${encodeURIComponent(i.email).replace(/%40/gi, '@')}">${escapeHtml(i.contact_name)} ? ${escapeHtml(i.email)}</a><p>${escapeHtml(i.message)}</p><button type="button" class="inquiry-mark" data-inquiry="${i.id}" data-status="${i.status === 'new' ? 'contacted' : 'new'}">Mark ${i.status === 'new' ? 'contacted' : 'new'}</button></article>`
            )
            .join('')
        : '<p class="secure-note">No partnership enquiries yet. Your league?s partner card is open to local businesses.</p>';
    } catch (error) {
      byId('partnerInquiries').textContent = error.message;
    }
  }
  function connectLiveUpdates() {
    if (!slug || typeof EventSource === 'undefined') return;
    if (liveUpdateSlug === slug && liveUpdates) return;
    liveUpdates?.close();
    liveUpdateSlug = slug;
    liveUpdates = new EventSource('/api/leagues/' + encodeURIComponent(slug) + '/live-updates');
    liveUpdates.onmessage = () => {
      if (!document.hidden) loadDetail();
    };
  }
  async function loadDetail() {
    directory.hidden = true;
    detail.hidden = false;
    byId('detailError')?.remove();
    try {
      const { league } = await fdApi(`/api/leagues/${encodeURIComponent(slug)}`);
      renderDetail(league);
      connectLiveUpdates();
      if (byId('matchModal').classList.contains('open') && activeMatchId) {
        const match = league.matches.find((item) => item.id === activeMatchId);
        if (match) {
          const tab =
            byId('matchReadOnly').querySelector('[data-match-tab].active')?.dataset.matchTab;
          renderMatchPanel(match, tab);
        }
      }
    } catch (error) {
      const notice = document.createElement('section');
      notice.id = 'detailError';
      notice.className = 'not-found';
      notice.innerHTML = `<span class="eyebrow">League unavailable</span><h1>This league isn?t public.</h1><p>${escapeHtml(error.message)} If you manage it, sign in with the creator account.</p><a class="btn-primary" href="/leagues.html">Browse public leagues</a><button class="btn-quiet" type="button" data-auth-open>Manager sign in</button>`;
      detail.prepend(notice);
    }
  }
  const requireOwner = () => {
    if (activeLeague?.canManage) return true;
    openModal('accountModal');
    return false;
  };
  byId('createLeagueOpen').onclick = () => {
    if (!account) {
      pendingCreate = true;
      document.querySelector('#accountModal [data-mode="register"]')?.click();
      openModal('accountModal');
      return;
    }
    openModal('createLeagueModal');
  };
  window.fdOnLogin = async () => {
    await loadAccount();
    if (slug) {
      await loadDetail();
      return;
    }
    await loadDirectory();
    if (pendingCreate) {
      pendingCreate = false;
      openModal('createLeagueModal');
    }
  };
  byId('createLeagueForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = byId('createError');
    error.style.display = 'none';
    const teams = byId('newLeagueTeams')
        .value.split(/\n|,/)
        .map((s) => s.trim())
        .filter(Boolean),
      logo = byId('newLeagueLogo').files[0];
    try {
      const { league } = await fdApi('/api/leagues', {
        method: 'POST',
        body: JSON.stringify({
          name: byId('newLeagueName').value,
          description: byId('newLeagueDescription').value,
          ownerDisplayName: byId('newManagerDisplayName').value,
          bannerPattern: byId('newBannerPattern').value,
          teams,
        }),
      });
      slug = league.slug;
      activeLeague = league;
      if (logo) await uploadImage('league', null, logo);
      closeModal(byId('createLeagueModal'));
      event.target.reset();
      history.pushState({}, '', `/leagues/${league.slug}`);
      await loadDetail();
      fdToast('Your league is live. You are the manager.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  let activeMatchId = null;
  function localInputDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(+d)) return '';
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  function goalRow(eventData = {}) {
    const match = activeLeague.matches.find((m) => m.id === activeMatchId),
      home = activeLeague.teams.find((t) => t.id === match.home_team_id),
      away = activeLeague.teams.find((t) => t.id === match.away_team_id),
      teamId = eventData.team_id || home.id,
      team = activeLeague.teams.find((t) => t.id === teamId),
      players = team?.players || [],
      type = eventData.event_type || 'goal',
      editable = !eventData.created_at || Date.now() - Date.parse(eventData.created_at) < 86400000,
      opts = (list, selected) =>
        '<option value="">Choose player</option>' +
        list
          .map(
            (p) =>
              '<option value="' +
              p.id +
              '" ' +
              (p.id === selected ? 'selected' : '') +
              '>' +
              escapeHtml(p.name) +
              (p.shirt_number === null ? '' : ' #' + p.shirt_number) +
              (p.position ? ' - ' + escapeHtml(p.position) : '') +
              '</option>'
          )
          .join(''),
      disabled = editable ? '' : 'disabled';
    return (
      '<div class="goal-row match-event-row" data-event-id="' +
      (eventData.id || '') +
      '" data-event-created="' +
      (eventData.created_at || '') +
      '" data-event-added="' +
      (eventData.added_time || 0) +
      '"><label class="event-type-field"><span>Event type</span><select data-event-type ' +
      disabled +
      '><option value="goal" ' +
      (type === 'goal' ? 'selected' : '') +
      '>Goal</option><option value="penalty" ' +
      (type === 'penalty' ? 'selected' : '') +
      '>Penalty</option><option value="own_goal" ' +
      (type === 'own_goal' ? 'selected' : '') +
      '>Own goal</option><option value="yellow_card" ' +
      (type === 'yellow_card' ? 'selected' : '') +
      '>Yellow card</option><option value="red_card" ' +
      (type === 'red_card' ? 'selected' : '') +
      '>Red card</option></select></label><label class="event-team-field"><span>Club</span><select data-goal-team ' +
      disabled +
      '><option value="' +
      home.id +
      '" ' +
      (teamId === home.id ? 'selected' : '') +
      '>' +
      escapeHtml(home.name) +
      '</option><option value="' +
      away.id +
      '" ' +
      (teamId === away.id ? 'selected' : '') +
      '>' +
      escapeHtml(away.name) +
      '</option></select></label><label class="event-player-field"><span>Player (' +
      escapeHtml(team?.name || 'club') +
      ')</span><select data-goal-player ' +
      disabled +
      ' required>' +
      opts(players, eventData.player_id) +
      '</select></label><label class="event-assist-field" ' +
      (!['goal', 'penalty', 'own_goal'].includes(type) ? 'hidden' : '') +
      '><span>Assist (optional)</span><select data-goal-assist ' +
      disabled +
      '>' +
      opts(players, eventData.assist_player_id) +
      '</select></label><label class="goal-minute-field"><span>Minute</span><input data-goal-minute type="number" min="1" max="120" value="' +
      (eventData.minute || 1) +
      '" aria-label="Event minute" ' +
      disabled +
      '></label>' +
      (editable
        ? '<button type="button" class="goal-remove" aria-label="Remove match event" title="Remove event"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>'
        : '<small class="event-locked-note">Locked after 24 hours</small>') +
      '</div>'
    );
  }
  function drawGoalRows(match) {
    byId('goalRows').innerHTML = (match.goals || []).map((g) => goalRow(g)).join('');
    updateGoalPreview();
    syncGoalControls();
  }
  function updateGoalPreview() {
    if (!activeLeague || !activeMatchId) return;
    const match = activeLeague.matches.find((m) => m.id === activeMatchId),
      rows = [...byId('goalRows').querySelectorAll('.goal-row')].filter(
        (row) =>
          ['goal', 'penalty', 'own_goal'].includes(row.querySelector('[data-event-type]')?.value) &&
          row.querySelector('[data-goal-player]').value
      ),
      home = rows.filter((row) => {
        const team = row.querySelector('[data-goal-team]').value,
          type = row.querySelector('[data-event-type]').value;
        return type === 'own_goal' ? team === match.away_team_id : team === match.home_team_id;
      }).length,
      away = rows.filter((row) => {
        const team = row.querySelector('[data-goal-team]').value,
          type = row.querySelector('[data-event-type]').value;
        return type === 'own_goal' ? team === match.home_team_id : team === match.away_team_id;
      }).length;
    byId('goalScorePreview').textContent = home + ' - ' + away;
  }
  function syncGoalControls() {
    const status = byId('matchStatus').value,
      mode = document.querySelector('.match-manager-tools')?.dataset.mode || 'status',
      live = status === 'live',
      editableRows = [...byId('goalRows').querySelectorAll('.goal-row')].some(
        (row) => !row.querySelector('.event-locked-note')
      ),
      canEdit = live || (status === 'played' && editableRows);
    byId('addGoalRow').disabled = !live;
    byId('goalRows')
      .querySelectorAll('select,input')
      .forEach((control) => {
        const row = control.closest('.goal-row');
        control.disabled = !row || Boolean(row.querySelector('.event-locked-note'));
      });
    byId('goalRows')
      .querySelectorAll('.goal-remove')
      .forEach(
        (button) =>
          (button.disabled = Boolean(
            button.closest('.goal-row').querySelector('.event-locked-note')
          ))
      );
    const save = byId('saveMatchEvents');
    save.disabled = mode === 'goals' && !canEdit;
    save.textContent =
      mode === 'status'
        ? 'Save match status'
        : canEdit
          ? 'Save match events'
          : 'No editable events remain';
    byId('goalRows').classList.toggle('events-locked', !canEdit);
  }
  function matchBadge(team) {
    return team?.logoUrl
      ? `<span class="match-hero-crest has-logo"><img src="${escapeHtml(team.logoUrl)}" alt=""></span>`
      : `<span class="match-hero-crest${team?.logoUrl ? ' has-logo' : ''}" style="--team-color:${escapeHtml(team?.color || '#6556d9')}">${escapeHtml(team?.short_name || 'FC')}</span>`;
  }
  function renderMatchPanel(match, tab) {
    const home = activeLeague.teams.find((t) => t.id === match.home_team_id),
      away = activeLeague.teams.find((t) => t.id === match.away_team_id),
      tableRows =
        match.status === 'live'
          ? activeLeague.liveStandings || activeLeague.standings
          : activeLeague.standings,
      hr = tableRows.find((t) => t.id === home?.id),
      ar = tableRows.find((t) => t.id === away?.id),
      scheduled = match.status === 'scheduled',
      events = match.goals || [],
      sheets = match.squads || {};
    const tabs = scheduled
      ? [
          ['preview', 'Preview'],
          ['lineups', 'Lineups'],
          ['form', 'Form'],
        ]
      : [
          ['timeline', 'Timeline'],
          ['lineups', 'Lineups'],
          ['stats', 'Stats'],
        ];
    if (!tabs.some(([id]) => id === tab)) tab = tabs[0][0];
    let content = '';
    if (tab === 'preview')
      content = `<div class="match-preview-facts"><article><small>Kickoff</small><b>${escapeHtml(formatDate(match.kickoff_at))} · ${escapeHtml(formatTime(match.kickoff_at))}</b></article><article><small>Venue</small><b>${escapeHtml(match.venue || 'To be confirmed')}</b></article><article><small>Matchday</small><b>${match.matchweek} of ${Math.max(1, ...activeLeague.matches.map((m) => Number(m.matchweek) || 1))}</b></article></div><div class="match-preview-note"><b>Before the whistle</b><p>Check back here on matchday for team sheets, goals and live updates.</p></div>`;
    if (tab === 'lineups')
      content = `<div class="match-lineups">${[
        { team: home, sheet: sheets[match.home_team_id] },
        { team: away, sheet: sheets[match.away_team_id] },
      ]
        .map(
          ({ team, sheet }) =>
            `<section><h3>${matchBadge(team)}${escapeHtml(team?.name || 'Club')}</h3>${sheet ? `<div class="match-lineup-columns"><div><b>Starting XI</b>${sheet.starting.map((p) => `<p>${p.shirt_number ?? '—'} · ${escapeHtml(p.name)} <small>${escapeHtml(p.position || '')}</small></p>`).join('')}</div><div><b>Bench</b>${sheet.bench.length ? sheet.bench.map((p) => `<p>${p.shirt_number ?? '—'} · ${escapeHtml(p.name)}</p>`).join('') : '<p class="match-muted">No substitutes listed</p>'}</div></div>` : '<p class="match-muted">The manager has not published this team sheet.</p>'}</section>`
        )
        .join('')}</div>`;
    if (tab === 'form')
      content = `<div class="match-form-grid">${[
        { team: home, row: hr },
        { team: away, row: ar },
      ]
        .map(
          ({ team, row }) =>
            `<section><div class="match-form-title">${matchBadge(team)}<b>${escapeHtml(team?.name || 'Club')}</b><span>${row?.position ? `#${row.position} · ${row.points} pts` : 'No table position'}</span></div><div class="match-form-dots">${row?.form?.length ? row.form.map((r) => `<i class="${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</i>`).join('') : 'No results yet'}</div></section>`
        )
        .join('')}</div>`;
    if (tab === 'timeline')
      content = events.length
        ? `<div class="match-timeline">${events
            .map((g) => {
              const card = g.event_type === 'yellow_card' || g.event_type === 'red_card',
                label =
                  {
                    goal: 'Goal',
                    penalty: 'Penalty',
                    own_goal: 'Own goal',
                    yellow_card: 'Yellow card',
                    red_card: 'Red card',
                  }[g.event_type] || 'Goal';
              return `<article class="${card ? 'card-event' : ''}"><span>${g.minute}${g.added_time ? `+${g.added_time}` : ''}'</span><b class="event-icon ${g.event_type}">${card ? (g.event_type === 'yellow_card' ? 'YC' : 'RC') : '&#9917;'}</b><div><strong>${escapeHtml(g.player_name || label)} - ${label}</strong><small>${escapeHtml(activeLeague.teams.find((t) => t.id === g.team_id)?.name || 'Club')}${g.assist_name ? ` - Assist: ${escapeHtml(g.assist_name)}` : ''}</small></div></article>`;
            })
            .join('')}</div>`
        : `<div class="match-preview-note"><b>${match.status === 'live' ? 'Match in progress' : 'No match events recorded'}</b><p>${match.status === 'live' ? 'Goals and cards appear here as they are recorded.' : 'There are no recorded events for this match.'}</p></div>`;
    if (tab === 'stats') {
      const stats = [
        ['League position', hr?.position ?? '—', ar?.position ?? '—'],
        ['Points', hr?.points ?? 0, ar?.points ?? 0],
        ['Goals scored', hr?.gf ?? 0, ar?.gf ?? 0],
        ['Goals conceded', hr?.ga ?? 0, ar?.ga ?? 0],
        ['Wins', hr?.won ?? 0, ar?.won ?? 0],
        ['Draws', hr?.drawn ?? 0, ar?.drawn ?? 0],
        ['Losses', hr?.lost ?? 0, ar?.lost ?? 0],
      ];
      content = `<div class="match-stats">${stats.map(([label, a, b]) => `<div class="match-stat-row"><b>${a}</b><span>${label}</span><b>${b}</b></div>`).join('')}<p class="match-muted">${match.status === 'live' ? 'Live provisional table; position and totals update with the score.' : 'Season totals from the current league table.'}</p></div>`;
    }
    byId('matchReadOnly').innerHTML =
      `<section class="match-scoreboard"><div class="match-comp-line"><span>${escapeHtml(activeLeague.name)} · ${escapeHtml(formatDate(match.kickoff_at))}</span><b class="${match.status === 'live' ? 'is-live' : ''}">${match.status === 'live' ? 'Live now' : scheduled ? 'Upcoming' : 'Full-time'}</b></div><div class="match-scoreline"><div class="match-club">${matchBadge(home)}<b>${escapeHtml(match.home_name)}</b>${hr ? `<small>${hr.position}${ordinal(hr.position)}</small>` : ''}</div><strong class="match-score">${scheduled ? '—' : match.home_score}<i>–</i>${scheduled ? '—' : match.away_score}</strong><div class="match-club">${matchBadge(away)}<b>${escapeHtml(match.away_name)}</b>${ar ? `<small>${ar.position}${ordinal(ar.position)}</small>` : ''}</div></div>${
        !scheduled && events.length
          ? `<div class="match-score-events"><div>${events
              .filter((g) => g.team_id === match.home_team_id)
              .map(
                (g) =>
                  `<span>${g.event_type === 'yellow_card' ? 'YC: ' : g.event_type === 'red_card' ? 'RC: ' : ''}${escapeHtml(g.player_name || 'Goal')} ${g.minute}${g.added_time ? `+${g.added_time}` : ''}'</span>`
              )
              .join('')}</div><div>${events
              .filter((g) => g.team_id === match.away_team_id)
              .map(
                (g) =>
                  `<span>${g.event_type === 'yellow_card' ? 'YC: ' : g.event_type === 'red_card' ? 'RC: ' : ''}${escapeHtml(g.player_name || 'Goal')} ${g.minute}${g.added_time ? `+${g.added_time}` : ''}'</span>`
              )
              .join('')}</div></div>`
          : ''
      }</section><nav class="match-detail-tabs" aria-label="Match information">${tabs.map(([id, label]) => `<button type="button" data-match-tab="${id}" class="${tab === id ? 'active' : ''}" aria-selected="${tab === id}">${label}</button>`).join('')}</nav><section class="match-tab-panel">${content}</section>`;
  }
  function ordinal(value) {
    const n = Number(value),
      suffix = ['th', 'st', 'nd', 'rd'],
      v = n % 100;
    return suffix[(v - 20) % 10] || suffix[v] || suffix[0];
  }
  function openMatch(id, tab, managerMode = 'status') {
    const match = activeLeague.matches.find((m) => m.id === id);
    if (!match) return;
    activeMatchId = id;
    const tools = document.querySelector('.match-manager-tools');
    tools.dataset.mode = managerMode;
    tools.classList.toggle('is-owner', activeLeague.canManage);
    byId('matchModalTitle').textContent = match.home_name + ' vs ' + match.away_name;
    renderMatchPanel(match, tab || (match.status === 'scheduled' ? 'preview' : 'timeline'));
    byId('matchStatus').innerHTML =
      match.status === 'scheduled'
        ? '<option value="scheduled">Upcoming</option><option value="live">Live - start match</option>'
        : match.status === 'live'
          ? '<option value="scheduled">Upcoming - reset match</option><option value="live">Live</option><option value="played">Full time - end match</option>'
          : '<option value="played">Full time</option>';
    byId('matchStatus').value = match.status;
    byId('matchStatus').disabled = managerMode === 'goals' || match.status === 'played';
    byId('matchStatus').closest('.field').hidden = managerMode === 'goals';
    byId('goalScorePreview').closest('.goal-score-preview').hidden = managerMode === 'status';
    byId('goalEditor').hidden = managerMode === 'status';
    for (const id of ['addGoalRow', 'addYellowCard', 'addRedCard'])
      byId(id).hidden = match.status === 'played';
    byId('goalEditorHelp').textContent =
      match.status === 'live'
        ? 'Record goals, yellow cards or red cards. Live events can be corrected while the match is in progress.'
        : match.status === 'played'
          ? 'Existing events can be corrected or removed for 24 hours after they were recorded. New events cannot be added after full time.'
          : 'Start the match in the Match status tab before adding match events.';
    drawGoalRows(match);
    if (managerMode === 'squads') {
      openMatchSquads();
      return;
    }
    openModal('matchModal');
  }
  function openFixtureEdit(id) {
    const match = activeLeague.matches.find((m) => m.id === id);
    if (!match || !requireOwner()) return;
    activeMatchId = id;
    byId('fixtureEditError').style.display = 'none';
    byId('fixtureEditTitle').textContent = match.home_name + ' vs ' + match.away_name;
    byId('matchDate').value = localInputDate(match.kickoff_at);
    byId('matchWeek').textContent = match.matchweek;
    byId('matchVenue').value = match.venue || '';
    openModal('fixtureEditModal');
  }
  function openTeamProfile(teamId) {
    const team = activeLeague.teams.find((t) => t.id === teamId),
      row = activeLeague.standings.find((t) => t.id === teamId);
    if (!team || !row) return;
    const played = activeLeague.matches
      .filter(
        (m) => m.status === 'played' && (m.home_team_id === teamId || m.away_team_id === teamId)
      )
      .sort((a, b) => new Date(b.kickoff_at) - new Date(a.kickoff_at))
      .slice(0, 5);
    const upcoming = activeLeague.matches
      .filter(
        (m) => m.status !== 'played' && (m.home_team_id === teamId || m.away_team_id === teamId)
      )
      .sort((a, b) => new Date(a.kickoff_at) - new Date(b.kickoff_at))
      .slice(0, 5);
    const matchCards = (matches) =>
      matches.length
        ? matches
            .map(
              (m) =>
                `<button class="team-fixture" type="button" data-team-match="${m.id}"><span>${m.status === 'played' ? 'FT' : m.status === 'live' ? 'LIVE' : `MW ${m.matchweek}`}</span><strong>${escapeHtml(m.home_short)} <b>${m.status === 'scheduled' ? '—' : `${m.home_score} : ${m.away_score}`}</b> ${escapeHtml(m.away_short)}</strong><small>${escapeHtml(formatDate(m.kickoff_at))} | ${escapeHtml(formatTime(m.kickoff_at))} | ${escapeHtml(m.venue || 'TBD')}</small></button>`
            )
            .join('')
        : '<p class="team-empty">Nothing scheduled yet.</p>';
    byId('teamProfile').innerHTML =
      `<div class="team-profile-head"><span class="team-profile-crest${team.logoUrl ? ' has-logo' : ''}" style="--team-color:${escapeHtml(team.color)}">${team.logoUrl ? `<img src="${escapeHtml(team.logoUrl)}" alt="">` : escapeHtml(team.short_name)}</span><div class="team-profile-copy"><span class="eyebrow">Club profile</span><h2 id="teamModalTitle">${escapeHtml(team.name)}</h2><p>Position ${row.position} · ${row.points} points</p></div>${activeLeague.canManage ? `<button type="button" class="btn-quiet team-edit-details" data-team-edit="${team.id}">Edit club details</button>` : ''}</div><div class="team-stat-grid"><div><strong>${row.played}</strong><span>Played</span></div><div><strong>${row.won}-${row.drawn}-${row.lost}</strong><span>W-D-L</span></div><div><strong>${row.gf}:${row.ga}</strong><span>Goals</span></div><div><strong>${row.gd > 0 ? '+' : ''}${row.gd}</strong><span>Goal diff</span></div></div><div class="team-profile-columns"><section><div class="card-title"><div><span class="eyebrow">First team</span><h3>Squad</h3></div><span class="secure-mini">${team.players.length} players</span></div><div class="team-roster">${team.players.length ? team.players.map((p, i) => `<div class="team-roster-row"><span class="roster-number">${p.shirt_number ?? String(i + 1).padStart(2, '0')}</span>${playerName(p)}<small>${escapeHtml(p.position || 'Player')}</small></div>`).join('') : '<p class="team-empty">No squad has been published yet.</p>'}</div></section><section><div class="card-title"><div><span class="eyebrow">Form guide</span><h3>Recent results</h3></div>${formDots(row.form)}</div><div class="team-fixture-list">${matchCards(played)}</div><div class="card-title team-upcoming-title"><div><span class="eyebrow">Next matches</span><h3>Fixtures</h3></div></div><div class="team-fixture-list">${matchCards(upcoming)}</div></section></div>`;
    openModal('teamModal');
  }
  byId('matchReadOnly').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-match-tab]');
    if (tab) openMatch(activeMatchId, tab.dataset.matchTab);
  });
  byId('tableBody').addEventListener('click', (event) => {
    const button = event.target.closest('[data-team-profile]');
    if (button) openTeamProfile(button.dataset.teamProfile);
  });
  byId('clubDirectory').addEventListener('click', (event) => {
    const button = event.target.closest('[data-team-profile]');
    if (button) openTeamProfile(button.dataset.teamProfile);
  });
  document.querySelector('.league-nav').addEventListener('click', (event) => {
    const link = event.target.closest('[data-league-nav]');
    if (!link) return;
    event.preventDefault();
    setLeagueView(link.dataset.leagueNav);
    history.replaceState(
      {},
      '',
      `${location.pathname}${location.search}#${link.dataset.leagueNav}`
    );
    byId('leagueDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  byId('leagueDetail').addEventListener('click', (event) => {
    const shortcut = event.target.closest('[data-go-tab]');
    if (!shortcut) return;
    setLeagueView(shortcut.dataset.goTab);
    history.replaceState(
      {},
      '',
      `${location.pathname}${location.search}#${shortcut.dataset.goTab}`
    );
    byId('leagueDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  for (const container of [byId('topScorers'), byId('playerDirectory')])
    container.addEventListener('click', (event) => {
      const pageButton = event.target.closest('[data-player-page]');
      if (pageButton && !pageButton.disabled) {
        playerDirectoryPage += Number(pageButton.dataset.playerPage);
        renderSearchablePlayers();
        return;
      }
      const button = event.target.closest('[data-player-profile]');
      if (button) openPlayerProfile(button.dataset.playerProfile);
    });
  document.querySelector('.stat-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-stat-kind]');
    if (!button) return;
    document
      .querySelectorAll('[data-stat-kind]')
      .forEach((tab) => tab.classList.toggle('active', tab === button));
    renderStatLeaders(button.dataset.statKind);
  });
  byId('playerSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    playerDirectoryPage = 0;
    renderSearchablePlayers();
  });
  byId('playerSearchInput').addEventListener('input', renderSearchablePlayers);
  byId('clearPlayerSearch').addEventListener('click', () => {
    byId('playerSearchInput').value = '';
    renderSearchablePlayers();
    byId('playerSearchInput').focus();
  });
  byId('teamProfile').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-team-edit]');
    if (edit) {
      openTeamEdit(edit.dataset.teamEdit);
      return;
    }
    const player = event.target.closest('[data-player-profile]');
    if (player) {
      openPlayerProfile(player.dataset.playerProfile);
      return;
    }
    const button = event.target.closest('[data-team-match]');
    if (!button) return;
    closeModal(byId('teamModal'));
    openMatch(button.dataset.teamMatch);
  });
  function openPlayerProfile(playerId) {
    const team = activeLeague.teams.find((t) => t.players.some((p) => p.id === playerId)),
      p = team?.players.find((x) => x.id === playerId);
    if (!p) return;
    byId('playerProfile').innerHTML =
      `<div class="player-profile"><div class="player-profile-head">${
        p.photoUrl
          ? `<img src="${escapeHtml(p.photoUrl)}" alt="${escapeHtml(p.name)}">`
          : `<span class="player-avatar">${escapeHtml(
              p.name
                .split(/\s+/)
                .map((s) => s[0])
                .slice(0, 2)
                .join('')
                .toUpperCase()
            )}</span>`
      }<div><span class="eyebrow">${escapeHtml(team.name)} · #${p.shirt_number ?? '—'}</span><h2 id="playerProfileTitle">${escapeHtml(p.name)}</h2><p>${escapeHtml(p.position || 'Player')}</p>${activeLeague.canManage ? `<button class="btn-quiet" type="button" data-player-edit="${p.id}">Edit player</button>` : ''}</div></div><div class="player-stats"><div><strong>${p.stats?.appearances || 0}</strong><span>Appearances</span></div><div><strong>${p.stats?.goals || 0}</strong><span>Goals</span></div><div><strong>${p.stats?.assists || 0}</strong><span>Assists</span></div><div><strong>${p.stats?.yellowCards || 0}</strong><span>Yellow cards</span></div><div><strong>${p.stats?.redCards || 0}</strong><span>Red cards</span></div></div></div>`;
    openModal('playerProfileModal');
  }
  function openTeamEdit(teamId) {
    if (!requireOwner()) return;
    const t = activeLeague.teams.find((x) => x.id === teamId);
    if (!t) return;
    byId('editTeamName').value = t.name;
    byId('editTeamShort').value = t.short_name;
    byId('editTeamColor').value = t.color || '#1769ff';
    byId('editTeamLogo').value = '';
    byId('editTeamLogoPreview').src = t.logoUrl || '';
    byId('editTeamLogoPreview').hidden = !t.logoUrl;
    byId('editTeamForm').dataset.teamId = teamId;
    openModal('editTeamModal');
  }
  function openPlayerEdit(playerId) {
    if (!requireOwner()) return;
    const t = activeLeague.teams.find((x) => x.players.some((p) => p.id === playerId)),
      p = t?.players.find((x) => x.id === playerId);
    if (!p) return;
    byId('editPlayerForm').dataset.teamId = t.id;
    byId('editPlayerForm').dataset.playerId = p.id;
    byId('editPlayerName').value = p.name;
    byId('editPlayerNumber').value = p.shirt_number ?? '';
    byId('editPlayerPosition').value = p.position || '';
    byId('editPlayerPhoto').value = '';
    byId('editPlayerPhotoPreview').src = p.photoUrl || '';
    byId('editPlayerPhotoPreview').hidden = !p.photoUrl;
    openModal('editPlayerModal');
  }
  byId('playerProfile').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-player-edit]');
    if (edit) openPlayerEdit(edit.dataset.playerEdit);
  });
  function updateLineupSelection() {
    const team = activeLeague.teams.find((t) => t.id === byId('lineupTeam').value);
    if (!team) return;
    const checks = [...byId('startingEleven').querySelectorAll('input[type="checkbox"]')],
      selected = checks.filter((input) => input.checked).length,
      bench = Math.max(0, team.players.length - selected);
    byId('startingCount').textContent = selected + ' / 11 starters';
    byId('benchCount').textContent = bench + ' on the bench';
    byId('saveMatchSquad').disabled = selected !== 11 || team.players.length < 11;
    byId('lineupSelectionHint').textContent =
      team.players.length < 11
        ? 'This club needs at least 11 players before you can save a team sheet.'
        : selected === 11
          ? 'Starting XI ready ? remaining players become the bench.'
          : 'Select ' +
            (11 - selected) +
            ' more ' +
            (11 - selected === 1 ? 'player' : 'players') +
            '.';
    checks.forEach((input) => {
      input.disabled = !input.checked && selected >= 11;
    });
  }
  function fillLineupTeam() {
    const team = activeLeague.teams.find((t) => t.id === byId('lineupTeam').value);
    if (!team) return;
    const match = activeLeague.matches.find((m) => m.id === activeMatchId),
      saved = match?.squads?.[team.id],
      starters = new Set((saved?.starting || []).map((p) => p.id));
    const groups = [
      { code: 'GK', label: 'Goalkeepers', positions: ['Goalkeeper'] },
      {
        code: 'DEF',
        label: 'Defenders',
        positions: ['Right Back', 'Left Back', 'Centre Back', 'Wing Back'],
      },
      {
        code: 'MID',
        label: 'Midfielders',
        positions: ['Defensive Midfielder', 'Central Midfielder', 'Attacking Midfielder'],
      },
      {
        code: 'FWD',
        label: 'Forwards',
        positions: ['Right Winger', 'Left Winger', 'Second Striker', 'Striker'],
      },
    ];
    const playerOption = (p) =>
      '<label class="lineup-player-option"><input type="checkbox" value="' +
      p.id +
      '" ' +
      (starters.has(p.id) ? 'checked' : '') +
      '><span class="lineup-player-number">' +
      (p.shirt_number ?? '?') +
      '</span><span class="lineup-player-name">' +
      escapeHtml(p.name) +
      '<small>' +
      escapeHtml(p.position || 'Player') +
      '</small></span><span class="lineup-player-check" aria-hidden="true"></span></label>';
    const positionGroup = (code, label, players) =>
      players.length
        ? '<section class="lineup-position-group"><header><span class="lineup-position-code">' +
          code +
          '</span><strong>' +
          label +
          '</strong><small>' +
          players.length +
          '</small></header><div class="lineup-position-players">' +
          players.map(playerOption).join('') +
          '</div></section>'
        : '';
    const knownPositions = groups.flatMap((group) => group.positions);
    const groupedHtml = groups
      .map((group) =>
        positionGroup(
          group.code,
          group.label,
          team.players.filter((p) => group.positions.includes(p.position))
        )
      )
      .join('');
    const otherPlayers = team.players.filter((p) => !knownPositions.includes(p.position));
    byId('startingEleven').innerHTML = team.players.length
      ? groupedHtml + positionGroup('OTHER', 'Other positions', otherPlayers)
      : '<p class="team-empty">Add players to this club before selecting a matchday squad.</p>';
    byId('lineupVisible').checked = Boolean(saved?.visible);
    updateLineupSelection();
  }
  function openMatchSquads() {
    if (!requireOwner()) return;
    const match = activeLeague.matches.find((item) => item.id === activeMatchId);
    byId('lineupTeam').innerHTML = [match.home_team_id, match.away_team_id]
      .map((id) => activeLeague.teams.find((team) => team.id === id))
      .filter(Boolean)
      .map((team) => '<option value="' + team.id + '">' + escapeHtml(team.name) + '</option>')
      .join('');
    byId('lineupError').style.display = 'none';
    fillLineupTeam();
    openModal('matchSquadsModal');
  }
  byId('lineupTeam').addEventListener('change', fillLineupTeam);
  byId('startingEleven').addEventListener('change', (event) => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    const checked = byId('startingEleven').querySelectorAll('input[type="checkbox"]:checked');
    if (checked.length > 11) {
      event.target.checked = false;
      fdToast('A starting XI can only contain 11 players.');
    }
    updateLineupSelection();
  });
  byId('saveMatchSquad').onclick = async () => {
    if (!requireOwner()) return;
    const error = byId('lineupError'),
      teamId = byId('lineupTeam').value,
      team = activeLeague.teams.find((t) => t.id === teamId),
      startingPlayers = [
        ...byId('startingEleven').querySelectorAll('input[type="checkbox"]:checked'),
      ].map((input) => input.value);
    error.style.display = 'none';
    if (startingPlayers.length !== 11) {
      error.textContent = 'Select exactly 11 starting players.';
      error.style.display = 'block';
      return;
    }
    const starters = new Set(startingPlayers),
      benchPlayers = team.players
        .filter((player) => !starters.has(player.id))
        .map((player) => player.id);
    try {
      const { league } = await fdApi(
        '/api/leagues/' + activeLeague.slug + '/matches/' + activeMatchId + '/squads/' + teamId,
        {
          method: 'PATCH',
          body: JSON.stringify({
            startingPlayers,
            benchPlayers,
            visible: byId('lineupVisible').checked,
          }),
        }
      );
      renderDetail(league);
      closeModal(byId('matchSquadsModal'));
      openMatch(activeMatchId);
      fdToast('Starting XI saved. Remaining players are on the bench.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  };
  byId('managerWorkspace').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-manager-tab]');
    if (tab) {
      const name = tab.dataset.managerTab;
      byId('managerWorkspace')
        .querySelectorAll('[data-manager-tab]')
        .forEach((button) => {
          const active = button === tab;
          button.classList.toggle('active', active);
          button.setAttribute('aria-selected', String(active));
        });
      byId('managerWorkspace')
        .querySelectorAll('[data-manager-panel]')
        .forEach((panel) => {
          const active = panel.dataset.managerPanel === name;
          panel.classList.toggle('active', active);
          panel.hidden = !active;
        });
      return;
    }
    const action = event.target.closest('[data-manager-action]')?.dataset.managerAction;
    if (!action) return;
    if (action === 'club' && requireOwner()) openModal('addClubModal');
    if (action === 'fixtures' && requireOwner()) openFixtureManager('fixture');
    if (action === 'squads-roster' && requireOwner()) openSquads();
    if (action === 'status' && requireOwner()) openFixtureManager('status');
    if (action === 'goals' && requireOwner()) openFixtureManager('goals');
    if (action === 'squads' && requireOwner()) openFixtureManager('squads');
    if (action === 'settings') byId('editLeagueOpen').click();
    if (action === 'partners')
      byId('partnerInbox').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  byId('publicFixtureWeek').addEventListener('change', renderUpcomingWeek);
  for (const list of [byId('liveMatchList'), byId('resultsList'), byId('upcomingList')])
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-match-open]');
      if (button) openMatch(button.dataset.matchOpen);
    });
  byId('goalRows').addEventListener('change', (event) => {
    const row = event.target.closest('.goal-row');
    if (event.target.matches('[data-goal-team]') && row) {
      const team = activeLeague.teams.find((t) => t.id === event.target.value),
        players = team?.players || [],
        opts =
          '<option value="">Choose player</option>' +
          players
            .map(
              (p) =>
                '<option value="' +
                p.id +
                '">' +
                escapeHtml(p.name) +
                (p.shirt_number === null ? '' : ' #' + p.shirt_number) +
                (p.position ? ' - ' + escapeHtml(p.position) : '') +
                '</option>'
            )
            .join('');
      row.querySelector('[data-goal-player]').innerHTML = opts;
      row.querySelector('[data-goal-assist]').innerHTML = opts;
      row.querySelector('[data-goal-player]').closest('label').querySelector('span').textContent =
        'Player (' + (team?.name || 'club') + ')';
    }
    if (event.target.matches('[data-event-type]') && row) {
      const allowAssist = ['goal', 'penalty', 'own_goal'].includes(event.target.value);
      row.querySelector('.event-assist-field').hidden = !allowAssist;
      if (!allowAssist) row.querySelector('[data-goal-assist]').value = '';
    }
    updateGoalPreview();
  });
  byId('goalRows').addEventListener('click', (event) => {
    const button = event.target.closest('.goal-remove');
    if (!button) return;
    const row = button.closest('.goal-row');
    confirmWithUndo(
      'Remove this match event? The score or card stats will update when you save. You can undo within 5 seconds.',
      () => {
        row.remove();
        updateGoalPreview();
      }
    );
  });
  function addMatchEvent(type) {
    if (byId('matchStatus').value !== 'live') {
      fdToast('New events can only be added while the match is live.');
      return;
    }
    byId('goalRows').insertAdjacentHTML('beforeend', goalRow({ event_type: type }));
    updateGoalPreview();
  }
  byId('addGoalRow').onclick = () => addMatchEvent('goal');
  byId('addYellowCard').onclick = () => addMatchEvent('yellow_card');
  byId('addRedCard').onclick = () => addMatchEvent('red_card');
  byId('matchStatus').addEventListener('change', syncGoalControls);
  byId('fixtureEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const error = byId('fixtureEditError');
    error.style.display = 'none';
    try {
      const { league } = await fdApi(
        '/api/leagues/' + activeLeague.slug + '/matches/' + activeMatchId,
        {
          method: 'PATCH',
          body: JSON.stringify({
            kickoffAt: byId('matchDate').value
              ? new Date(byId('matchDate').value).toISOString()
              : '',
            venue: byId('matchVenue').value,
          }),
        }
      );
      closeModal(byId('fixtureEditModal'));
      renderDetail(league);
      fdToast('Fixture details saved.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  byId('resultEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const mode = document.querySelector('.match-manager-tools').dataset.mode || 'status',
      status = byId('matchStatus').value,
      match = activeLeague.matches.find((item) => item.id === activeMatchId),
      events = [...byId('goalRows').querySelectorAll('.goal-row')].map((row) => ({
        eventId: row.dataset.eventId || undefined,
        teamId: row.querySelector('[data-goal-team]').value,
        playerId: row.querySelector('[data-goal-player]').value || null,
        assistPlayerId: row.querySelector('[data-goal-assist]').value || null,
        eventType: row.querySelector('[data-event-type]').value,
        minute: Number(row.querySelector('[data-goal-minute]').value),
        addedTime: Number(row.dataset.eventAdded || 0),
      }));
    if (mode === 'goals' && events.some((item) => !item.playerId)) {
      fdToast('Choose a player for every match event.');
      return;
    }
    const save = async (body) => {
      try {
        const { league } = await fdApi(
          '/api/leagues/' + activeLeague.slug + '/matches/' + activeMatchId,
          { method: 'PATCH', body: JSON.stringify(body) }
        );
        closeModal(byId('matchModal'));
        renderDetail(league);
        fdToast(mode === 'goals' ? 'Match events saved.' : 'Match status saved.');
      } catch (err) {
        fdToast(err.message);
      }
    };
    if (status === 'scheduled' && match?.status === 'live') {
      confirmWithUndo(
        'Reset this live match to Upcoming? This clears its score, goals and cards. You can undo within 5 seconds.',
        () => save({ status: 'scheduled' })
      );
      return;
    }
    const body = { status };
    if (mode === 'goals') body.events = events;
    await save(body);
  });
  async function shareLeague() {
    if (activeLeague.visibility === 'private') {
      fdToast('This league is private. Change visibility in league settings to share it.');
      return;
    }
    const url = `${location.origin}/leagues/${activeLeague.slug}`,
      shareData = {
        title: `${activeLeague.name} | NexLiga`,
        text: `Follow ${activeLeague.name}: standings, fixtures and match updates.`,
        url,
      };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(url);
      fdToast('League link copied.');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      try {
        await navigator.clipboard.writeText(url);
        fdToast('League link copied.');
      } catch {
        prompt('Copy league link', url);
      }
    }
  }
  byId('shareLeague').onclick = shareLeague;
  byId('sponsorLink').addEventListener('click', (event) => {
    if (!activeLeague?.sponsor?.url) {
      event.preventDefault();
      if (activeLeague?.canManage) byId('editLeagueOpen').click();
      else openModal('sponsorModal');
    }
  });
  byId('sponsorForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = byId('sponsorError');
    error.style.display = 'none';
    try {
      await fdApi(`/api/leagues/${activeLeague.slug}/partner-inquiries`, {
        method: 'POST',
        body: JSON.stringify({
          businessName: byId('businessName').value,
          contactName: byId('contactName').value,
          email: byId('sponsorEmail').value,
          message: byId('sponsorMessage').value,
        }),
      });
      closeModal(byId('sponsorModal'));
      event.target.reset();
      fdToast('Enquiry sent to the league manager.');
      if (activeLeague.canManage) loadPartnerInquiries();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  byId('partnerInquiries').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-inquiry]');
    if (!button || !requireOwner()) return;
    try {
      await fdApi(`/api/leagues/${activeLeague.slug}/partner-inquiries/${button.dataset.inquiry}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: button.dataset.status }),
      });
      loadPartnerInquiries();
    } catch (err) {
      fdToast(err.message);
    }
  });
  byId('editLeagueOpen').onclick = () => {
    if (!requireOwner()) return;
    byId('editLeagueName').value = activeLeague.name;
    byId('editLeagueDescription').value = activeLeague.description;
    byId('editManagerDisplayName').value = activeLeague.ownerDisplayName || '';
    byId('editBannerPattern').value = activeLeague.bannerPattern || 'floodlights';
    byId('editVisibility').value = activeLeague.visibility;
    byId('editSponsorName').value = activeLeague.sponsor.name;
    byId('editSponsorTagline').value = activeLeague.sponsor.tagline;
    byId('editSponsorUrl').value = activeLeague.sponsor.url;
    byId('editLeagueLogoFile').value = '';
    byId('editLeagueLogoPreview').src = activeLeague.logoUrl || '';
    byId('editLeagueLogoPreview').hidden = !activeLeague.logoUrl;
    openModal('editLeagueModal');
  };
  byId('editLeagueForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const error = byId('editError');
    error.style.display = 'none';
    try {
      let { league } = await fdApi(`/api/leagues/${activeLeague.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: byId('editLeagueName').value,
          description: byId('editLeagueDescription').value,
          ownerDisplayName: byId('editManagerDisplayName').value,
          bannerPattern: byId('editBannerPattern').value,
          visibility: byId('editVisibility').value,
          sponsorName: byId('editSponsorName').value,
          sponsorTagline: byId('editSponsorTagline').value,
          sponsorUrl: byId('editSponsorUrl').value,
        }),
      });
      activeLeague = league;
      if (byId('editLeagueLogoFile').files[0])
        ({ league } = await uploadImage('league', null, byId('editLeagueLogoFile').files[0]));
      closeModal(byId('editLeagueModal'));
      slug = league.slug;
      history.replaceState({}, '', `/leagues/${league.slug}`);
      renderDetail(league);
      fdToast('League settings saved.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  byId('editTeamForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const form = event.currentTarget,
      error = byId('editTeamError'),
      teamId = form.dataset.teamId;
    error.style.display = 'none';
    try {
      let { league } = await fdApi(`/api/leagues/${activeLeague.slug}/teams/${teamId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: byId('editTeamName').value,
          shortName: byId('editTeamShort').value,
          color: byId('editTeamColor').value,
        }),
      });
      activeLeague = league;
      if (byId('editTeamLogo').files[0])
        ({ league } = await uploadImage('team', teamId, byId('editTeamLogo').files[0]));
      renderDetail(league);
      closeModal(byId('editTeamModal'));
      openTeamProfile(teamId);
      fdToast('Club details saved.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  byId('editPlayerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const form = event.currentTarget,
      error = byId('editPlayerError'),
      teamId = form.dataset.teamId,
      playerId = form.dataset.playerId;
    error.style.display = 'none';
    try {
      let { league } = await fdApi(
        `/api/leagues/${activeLeague.slug}/teams/${teamId}/players/${playerId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            name: byId('editPlayerName').value,
            shirtNumber: byId('editPlayerNumber').value,
            position: byId('editPlayerPosition').value,
          }),
        }
      );
      activeLeague = league;
      if (byId('editPlayerPhoto').files[0])
        ({ league } = await uploadImage('player', playerId, byId('editPlayerPhoto').files[0]));
      renderDetail(league);
      closeModal(byId('editPlayerModal'));
      openPlayerProfile(playerId);
      fdToast('Player details saved.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  byId('deleteLeague').onclick = () => {
    if (!requireOwner()) return;
    const leagueName = activeLeague.name,
      leagueSlug = activeLeague.slug;
    if (
      confirmWithUndo(
        'Delete ' +
          leagueName +
          ' and all its fixtures? Confirm only if you are sure. You can undo within 5 seconds.',
        async () => {
          try {
            await fdApi('/api/leagues/' + leagueSlug, { method: 'DELETE', body: '{}' });
            closeModal(byId('editLeagueModal'));
            slug = null;
            history.pushState({}, '', '/leagues.html');
            await loadDirectory();
            fdToast('League deleted.');
          } catch (err) {
            fdToast(err.message);
          }
        }
      )
    )
      closeModal(byId('editLeagueModal'));
  };
  byId('addClubForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const error = byId('clubError');
    error.style.display = 'none';
    try {
      let { league } = await fdApi(`/api/leagues/${activeLeague.slug}/teams`, {
        method: 'POST',
        body: JSON.stringify({ name: byId('newClubName').value }),
      });
      activeLeague = league;
      const team = league.teams.find((t) => t.name === byId('newClubName').value.trim());
      if (byId('newClubLogo').files[0])
        ({ league } = await uploadImage('team', team.id, byId('newClubLogo').files[0]));
      closeModal(byId('addClubModal'));
      event.target.reset();
      renderDetail(league);
      fdToast('Club added and fixtures generated.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  function renderSquadList() {
    const team = activeLeague.teams.find((t) => t.id === byId('squadClub').value);
    byId('squadList').innerHTML = team?.players.length
      ? team.players
          .map(
            (p) =>
              `<div class="squad-player"><span>${p.photoUrl ? `<img class="squad-player-photo" src="${escapeHtml(p.photoUrl)}" alt="">` : ''}${p.shirt_number === null ? '' : `#${p.shirt_number}`} ${playerName(p)}<small>${escapeHtml(p.position || '')}</small></span><span class="squad-player-actions"><button type="button" class="btn-quiet player-action-icon" data-player-edit="${p.id}" aria-label="Edit ${escapeHtml(p.name)}" title="Edit ${escapeHtml(p.name)}"><svg class="inline-button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m16 4 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/></svg></button><button type="button" class="btn-quiet player-action-icon" data-player-remove="${p.id}" aria-label="Remove ${escapeHtml(p.name)}" title="Remove ${escapeHtml(p.name)}"><svg class="inline-button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg></button></span></div>`
          )
          .join('')
      : '<div class="empty-state">No players in this squad yet. Add the first one below.</div>';
  }
  function openSquads() {
    if (!requireOwner()) return;
    byId('squadClub').innerHTML = activeLeague.teams
      .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
      .join('');
    renderSquadList();
    openModal('squadModal');
  }
  byId('manageSquadsOpen').onclick = openSquads;
  byId('squadClub').addEventListener('change', renderSquadList);
  byId('addPlayerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const teamId = byId('squadClub').value;
    try {
      let { league } = await fdApi(`/api/leagues/${activeLeague.slug}/teams/${teamId}/players`, {
        method: 'POST',
        body: JSON.stringify({
          name: byId('playerName').value,
          shirtNumber: byId('playerNumber').value,
          position: byId('playerPosition').value,
        }),
      });
      activeLeague = league;
      const player = league.teams
        .find((t) => t.id === teamId)
        .players.find((p) => p.name === byId('playerName').value.trim());
      if (byId('newPlayerPhoto').files[0])
        ({ league } = await uploadImage('player', player.id, byId('newPlayerPhoto').files[0]));
      activeLeague = league;
      event.target.reset();
      byId('squadClub').value = teamId;
      renderSquadList();
      fdToast('Player added to the club squad.');
    } catch (err) {
      fdToast(err.message);
    }
  });
  byId('bulkPlayersForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const teamId = byId('squadClub').value;
    const players = byId('bulkPlayers')
      .value.split(/\r?\n/)
      .map((line) => line.split(',').map((v) => v.trim()))
      .filter((row) => row.some(Boolean))
      .map(([name, shirtNumber, position]) => ({
        name,
        shirtNumber: shirtNumber || null,
        position,
      }));
    if (!players.length) {
      fdToast('Add at least one player line.');
      return;
    }
    if (players.some((p) => !p.name || !p.position)) {
      fdToast('Each line needs a player name and standard position.');
      return;
    }
    try {
      const { league } = await fdApi(
        '/api/leagues/' + activeLeague.slug + '/teams/' + teamId + '/players/bulk',
        { method: 'POST', body: JSON.stringify({ players }) }
      );
      activeLeague = league;
      byId('bulkPlayers').value = '';
      renderSquadList();
      fdToast(players.length + ' players imported.');
    } catch (err) {
      fdToast(err.message);
    }
  });
  byId('squadList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-player-remove]');
    if (!button || !requireOwner()) return;
    const teamId = byId('squadClub').value,
      player = activeLeague.teams
        .find((t) => t.id === teamId)
        ?.players.find((p) => p.id === button.dataset.playerRemove);
    confirmWithUndo(
      'Remove ' +
        (player?.name || 'this player') +
        ' from the club squad? You can undo within 5 seconds.',
      async () => {
        try {
          const { league } = await fdApi(
            '/api/leagues/' +
              activeLeague.slug +
              '/teams/' +
              teamId +
              '/players/' +
              button.dataset.playerRemove,
            { method: 'DELETE', body: '{}' }
          );
          activeLeague = league;
          renderSquadList();
          fdToast('Player removed from the squad.');
        } catch (err) {
          fdToast(err.message);
        }
      }
    );
  });
  let fixtureManagerMode = 'fixture';
  function fixturePickerRow(match) {
    const labels = { scheduled: 'Upcoming', live: 'Live', played: 'Concluded' },
      label = labels[match.status] || 'Upcoming',
      editableEvents = (match.goals || []).some(
        (event) => Date.now() - Date.parse(event.created_at) < 86400000
      ),
      blockedStatus = fixtureManagerMode === 'status' && match.status === 'played',
      blockedGoals =
        fixtureManagerMode === 'goals' &&
        (match.status === 'scheduled' || (match.status === 'played' && !editableEvents)),
      disabled = blockedStatus || blockedGoals,
      reason = blockedStatus
        ? 'This match has already concluded.'
        : blockedGoals
          ? match.status === 'played'
            ? 'The 24-hour event correction window has expired.'
            : 'Start the match before adding events.'
          : '',
      eventHint =
        fixtureManagerMode === 'goals' && match.status === 'played' && editableEvents
          ? 'Existing events can be corrected for 24 hours.'
          : '';
    return (
      '<button type="button" class="fixture-manage-row" data-fixture-edit="' +
      match.id +
      '" ' +
      (disabled ? 'disabled aria-disabled="true"' : '') +
      '><span class="fixture-manage-topline"><strong>' +
      escapeHtml(match.home_name) +
      ' <small>vs</small> ' +
      escapeHtml(match.away_name) +
      '</strong><span class="fixture-manager-status is-' +
      match.status +
      '">' +
      label +
      '</span></span><span>Date: ' +
      escapeHtml(formatDate(match.kickoff_at)) +
      '</span><span>Time: ' +
      escapeHtml(formatTime(match.kickoff_at)) +
      '</span><span>Venue: ' +
      escapeHtml(match.venue || 'TBD') +
      '</span>' +
      (eventHint ? '<small class="fixture-event-hint">' + eventHint + '</small>' : '') +
      (reason ? '<small class="fixture-unavailable-note">' + reason + '</small>' : '') +
      '</button>'
    );
  }
  function openFixtureManager(mode = 'fixture') {
    if (!requireOwner()) return;
    fixtureManagerMode = mode;
    const labels = {
        fixture: ['Fixtures by matchweek', 'Select a fixture to edit its date, kickoff or venue.'],
        status: [
          'Choose a match for status updates',
          'Upcoming and live matches are selectable. Concluded fixtures are disabled.',
        ],
        goals: [
          'Choose a match for events',
          'Add events while live; correct recorded events for up to 24 hours after they are entered.',
        ],
        squads: [
          'Choose a fixture for team sheets',
          'Select a match to publish its starting XI and bench.',
        ],
      },
      copy = labels[mode] || labels.fixture;
    byId('fixtureManagerTitle').textContent = copy[0];
    byId('fixtureManagerDescription').textContent = copy[1];
    byId('fixtureManagerAdd').hidden = mode !== 'fixture';
    const weeks = [...new Set(activeLeague.matches.map((m) => m.matchweek))].sort((a, b) => a - b);
    byId('fixtureWeekList').innerHTML = weeks.length
      ? weeks
          .map((week) => {
            const fixtures = activeLeague.matches
              .filter((m) => m.matchweek === week)
              .sort((a, b) => (a.kickoff_at || '').localeCompare(b.kickoff_at || ''));
            return (
              '<section class="fixture-week"><h3>Matchweek ' +
              week +
              '</h3>' +
              fixtures.map(fixturePickerRow).join('') +
              '</section>'
            );
          })
          .join('')
      : '<div class="empty-state">No fixtures yet. Add your first fixture.</div>';
    openModal('fixtureManagerModal');
  }
  byId('fixtureWeekList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-fixture-edit]');
    if (!row || !requireOwner()) return;
    closeModal(byId('fixtureManagerModal'));
    if (fixtureManagerMode === 'fixture') {
      openFixtureEdit(row.dataset.fixtureEdit);
      return;
    }
    if (fixtureManagerMode === 'squads') {
      activeMatchId = row.dataset.fixtureEdit;
      openMatchSquads();
      return;
    }
    openMatch(row.dataset.fixtureEdit, undefined, fixtureManagerMode);
  });
  byId('fixtureManagerAdd').onclick = () => {
    closeModal(byId('fixtureManagerModal'));
    openAddFixture();
  };
  function openAddFixture() {
    if (!requireOwner()) return;
    for (const select of [byId('fixtureHome'), byId('fixtureAway')])
      select.innerHTML = activeLeague.teams
        .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
        .join('');
    byId('fixtureWeek').value = Math.max(1, ...activeLeague.matches.map((m) => m.matchweek));
    byId('fixtureDate').value = '';
    openModal('addFixtureModal');
  }
  byId('addFixtureForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requireOwner()) return;
    const error = byId('fixtureError');
    error.style.display = 'none';
    try {
      const { league } = await fdApi(`/api/leagues/${activeLeague.slug}/matches`, {
        method: 'POST',
        body: JSON.stringify({
          homeTeamId: byId('fixtureHome').value,
          awayTeamId: byId('fixtureAway').value,
          matchweek: Number(byId('fixtureWeek').value),
          kickoffAt: byId('fixtureDate').value
            ? new Date(byId('fixtureDate').value).toISOString()
            : '',
          venue: byId('fixtureVenue').value,
        }),
      });
      closeModal(byId('addFixtureModal'));
      renderDetail(league);
      fdToast('Fixture published.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    }
  });
  byId('squadList').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-player-edit]');
    if (edit) {
      openPlayerEdit(edit.dataset.playerEdit);
      return;
    }
    const profile = event.target.closest('[data-player-profile]');
    if (profile) openPlayerProfile(profile.dataset.playerProfile);
  });
  window.addEventListener('popstate', () => {
    slug = location.pathname.match(/^\/leagues\/([a-z0-9-]+)/)?.[1] || null;
    if (!slug) {
      liveUpdates?.close();
      liveUpdates = null;
      liveUpdateSlug = null;
    }
    loadAccount().then(() => (slug ? loadDetail() : loadDirectory()));
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && slug && activeLeague) loadDetail();
  });
  window.setInterval(() => {
    if (slug && activeLeague && !activeLeague.canManage && !document.hidden) loadDetail();
  }, 30000);
  loadAccount().then(async () => {
    if (slug) {
      await loadDetail();
      return;
    }
    await loadDirectory();
    if (new URLSearchParams(location.search).get('create') === '1')
      byId('createLeagueOpen').click();
  });
})();
