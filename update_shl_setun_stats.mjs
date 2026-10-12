#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const DEFAULTS = {
  seasonId: 230,
  tournamentId: 4223,
  teamId: 2641,
  divisionName: "",
  delayMs: 60,
  matchLimit: 5,
  outputJson: "setun_shl_data.json",
  outputJs: "setun_shl_data.js",
};

const API_BASE = "https://mtgame.ru/api/v1";
const TEAM_PAGE_URL = (teamId) => `https://shlmos.ru/team/${teamId}`;
const SEASON_LABEL = "2026/2027";

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value == null || String(value).startsWith("--")) continue;

    if (["seasonId", "tournamentId", "teamId", "delayMs", "matchLimit"].includes(key)) {
      options[key] = Number(value);
      i += 1;
      continue;
    }

    if (["divisionName", "outputJson", "outputJs"].includes(key)) {
      options[key] = String(value);
      i += 1;
    }
  }
  return options;
}

function toInt(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function toNullableInt(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(path, query = null) {
  const base = `${API_BASE}${path}`;
  if (!query || typeof query !== "object") return base;
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value == null) return;
    params.set(String(key), String(value));
  });
  const suffix = params.toString();
  return suffix ? `${base}?${suffix}` : base;
}

async function fetchJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "SetunStatsUpdater/2.0",
        },
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`GET ${url} failed (${response.status}): ${text}`);
      }

      if (!text.trim()) {
        return null;
      }

      return JSON.parse(text);
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      await sleep(300 * attempt);
    }
  }

  return null;
}

function getByPath(source, path) {
  return path.split(".").reduce((acc, part) => (acc == null ? undefined : acc[part]), source);
}

function getPlayerNameFromUser(entry) {
  const candidates = [
    {
      last: getByPath(entry, "league_player.last_name"),
      first: getByPath(entry, "league_player.first_name"),
      middle: getByPath(entry, "league_player.middle_name"),
    },
    {
      last: getByPath(entry, "team_user.user.last_name"),
      first: getByPath(entry, "team_user.user.first_name"),
      middle: getByPath(entry, "team_user.user.middle_name"),
    },
    {
      last: getByPath(entry, "last_name"),
      first: getByPath(entry, "first_name"),
      middle: getByPath(entry, "middle_name"),
    },
  ];

  for (const src of candidates) {
    const parts = [src.last, src.first, src.middle]
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }

  return "Без имени";
}

function getBirthDateFromUser(entry) {
  const candidates = [
    getByPath(entry, "league_player.birth_date"),
    getByPath(entry, "team_user.user.birth_date"),
  ];

  for (const candidate of candidates) {
    const raw = String(candidate ?? "").trim();
    if (!raw) continue;
    const dt = new Date(raw);
    if (Number.isFinite(dt.getTime())) {
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const d = String(dt.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }

  return null;
}

function moscowDateTimeParts(isoDateTime) {
  const date = new Date(isoDateTime);
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
  };
}

function resolveWebUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `https://shlmos.ru${raw}`;
  return `https://shlmos.ru/${raw.replace(/^\/+/, "")}`;
}

function makeTourLabel(division, tour) {
  if (tour != null) {
    return `SHL ${division} · ${toInt(tour)} тур`;
  }
  return `SHL ${division}`;
}

function byDateAsc(left, right) {
  return new Date(String(left.datetime || "")).getTime() - new Date(String(right.datetime || "")).getTime();
}

function byDateDesc(left, right) {
  return new Date(String(right.datetime || "")).getTime() - new Date(String(left.datetime || "")).getTime();
}

function gameToPublicModel(game, divisionLabel) {
  const gameId = toInt(game?.id);
  const datetimeRaw = String(game?.datetime || "");
  const datetime = new Date(datetimeRaw);
  const local = moscowDateTimeParts(datetimeRaw);
  return {
    gameId,
    home: String(game?.team?.name || game?.team_name || ""),
    away: String(game?.competitor_team?.name || game?.competitor_team_name || ""),
    homeTeamId: toInt(game?.team_id),
    awayTeamId: toInt(game?.competitor_team_id),
    date: local.date,
    time: local.time,
    status: String(game?.status || ""),
    tour: makeTourLabel(divisionLabel, game?.tournament_tour),
    homeScore: toNullableInt(game?.team_score),
    awayScore: toNullableInt(game?.competitor_team_score),
    datetime,
  };
}

function isoNowNoMillis() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isValidDataShape(data) {
  if (!data || typeof data !== "object") return false;
  if (!data.meta || typeof data.meta !== "object") return false;
  if (!Array.isArray(data.standings)) return false;
  if (!Array.isArray(data.players)) return false;
  if (!Array.isArray(data.birthdays)) return false;
  if (!Array.isArray(data.upcomingMatches)) return false;
  if (!Array.isArray(data.pastMatches)) return false;
  return true;
}

function buildJsPayload(appData) {
  return `window.shlAppData = ${JSON.stringify(appData, null, 2)};\nwindow.playerGoalsData = window.shlAppData.players;\n`;
}

async function readPreviousData(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isValidDataShape(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validateFreshData(freshData, previousData, options) {
  if (!isValidDataShape(freshData)) {
    return { ok: false, reason: "invalid data shape" };
  }

  if (!String(freshData.meta.teamName || "").trim()) {
    return { ok: false, reason: "meta.teamName is empty" };
  }

  if (toInt(freshData.meta.tournamentId) !== toInt(options.tournamentId)) {
    return { ok: false, reason: "meta.tournamentId mismatch" };
  }

  if (freshData.standings.length === 0) {
    return { ok: false, reason: "standings are empty" };
  }

  if (!freshData.standings.some((row) => row && row.isOwn)) {
    return { ok: false, reason: "own team row is missing in standings" };
  }

  if (!Number.isFinite(Date.parse(String(freshData.meta.updatedAt || "")))) {
    return { ok: false, reason: "meta.updatedAt is invalid" };
  }

  if (previousData && isValidDataShape(previousData)) {
    const prevPlayers = previousData.players.length;
    const freshPlayers = freshData.players.length;
    if (prevPlayers > 0 && freshPlayers === 0) {
      return { ok: false, reason: "players unexpectedly became empty" };
    }

    const prevStandings = previousData.standings.length;
    const freshStandings = freshData.standings.length;
    if (prevStandings >= 4 && freshStandings < Math.floor(prevStandings / 2)) {
      return { ok: false, reason: "standings shrank unexpectedly" };
    }

    const prevMatches = previousData.upcomingMatches.length + previousData.pastMatches.length;
    const freshMatches = freshData.upcomingMatches.length + freshData.pastMatches.length;
    if (prevMatches > 0 && freshMatches === 0) {
      return { ok: false, reason: "all matches disappeared unexpectedly" };
    }
  }

  return { ok: true, reason: "ok" };
}

async function writeDataFiles(options, appData) {
  const json = `${JSON.stringify(appData, null, 2)}\n`;
  const js = buildJsPayload(appData);
  await writeFile(options.outputJson, json, "utf8");
  await writeFile(options.outputJs, js, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const previousData = await readPreviousData(options.outputJson);

  try {

    const tournament = await fetchJson(buildUrl(`/tournament/${options.tournamentId}/`));
    const allTeams = normalizeArray(await fetchJson(buildUrl(`/tournament/${options.tournamentId}/teams/`)));

    if (!allTeams.length) {
      throw new Error(`No teams found for tournament ${options.tournamentId}`);
    }

    const ownTeamRow = allTeams.find((row) => toInt(row?.team?.id) === options.teamId);
    if (!ownTeamRow) {
      throw new Error(`TeamId ${options.teamId} is not present in tournament ${options.tournamentId}`);
    }

    const ownTournamentTeamId = toInt(ownTeamRow.id);
    const ownTeamName = String(ownTeamRow.name || "Сетунь");
    const logoUrl = String(ownTeamRow?.logo?.path || "");
    const divisionLabel = options.divisionName || String(tournament?.name || "SHL");
    const cityName = String(ownTeamRow?.team?.city?.name || "");

    const teamsByTeamId = new Map();
    for (const row of allTeams) {
      const teamId = toInt(row?.team?.id);
      if (teamId > 0) {
        teamsByTeamId.set(teamId, row);
      }
    }

    const standingsSorted = [...allTeams].sort((left, right) => {
    const points = toInt(right?.points) - toInt(left?.points);
    if (points !== 0) return points;
    const diff = (toInt(right?.score_sum) - toInt(right?.missed_sum)) - (toInt(left?.score_sum) - toInt(left?.missed_sum));
    if (diff !== 0) return diff;
    const gf = toInt(right?.score_sum) - toInt(left?.score_sum);
    if (gf !== 0) return gf;
    return String(left?.name || "").localeCompare(String(right?.name || ""), "ru");
  });

    const standings = standingsSorted.map((row, index) => {
    const gf = toInt(row?.score_sum);
    const ga = toInt(row?.missed_sum);
    return {
      place: index + 1,
      team: String(row?.name || ""),
      games: toInt(row?.games_count),
      wins: toInt(row?.won_games_count),
      draws: toInt(row?.draw_games_count),
      losses: toInt(row?.lose_games_count),
      gf,
      ga,
      diff: gf - ga,
      points: toInt(row?.points),
      isOwn: toInt(row?.team?.id) === options.teamId,
    };
  });

    const games = [];
    const pageSize = 100;
    let page = 1;

    while (true) {
      const chunk = normalizeArray(
        await fetchJson(
          buildUrl(`/tournament/${options.tournamentId}/games/`, {
            page,
            size: pageSize,
          })
        )
      );

      if (!chunk.length) {
        break;
      }

      games.push(...chunk);
      if (chunk.length < pageSize) {
        break;
      }

      page += 1;
      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    if (!games.length) {
      throw new Error(`No games found for tournament ${options.tournamentId}`);
    }

    const now = new Date();
    const allGames = games
      .map((game) => gameToPublicModel(game, divisionLabel))
      .filter((game) => Number.isFinite(game.datetime.getTime()));

    const allUpcomingMatches = allGames
      .filter((game) => game.datetime.getTime() >= now.getTime())
      .sort((left, right) => left.datetime - right.datetime)
      .map((game) => ({
        gameId: game.gameId,
        home: game.home,
        away: game.away,
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        date: game.date,
        time: game.time,
        status: game.status,
        tour: game.tour,
      }));

    const allPastMatches = allGames
      .filter((game) => game.datetime.getTime() < now.getTime())
      .sort((left, right) => right.datetime - left.datetime)
      .map((game) => ({
        gameId: game.gameId,
        home: game.home,
        away: game.away,
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        date: game.date,
        time: game.time,
        status: game.status,
        tour: game.tour,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
      }));

    const setunGames = allGames
      .filter((game) => game.homeTeamId === options.teamId || game.awayTeamId === options.teamId)
      .sort((left, right) => left.datetime - right.datetime);

    let upcomingSetunGames = setunGames.filter((game) => game.datetime.getTime() >= now.getTime());
    if (upcomingSetunGames.length > options.matchLimit) {
      upcomingSetunGames = upcomingSetunGames.slice(0, options.matchLimit);
    }

    const upcomingMatches = upcomingSetunGames.map((game) => {
    const isHome = game.homeTeamId === options.teamId;
    return {
      gameId: game.gameId,
      home: game.home,
      away: game.away,
      date: game.date,
      time: game.time,
      venue: isHome ? "home" : "away",
      status: game.status,
      tour: game.tour,
    };
  });

    const pastSetunGames = setunGames
      .filter((game) => game.datetime.getTime() < now.getTime())
      .sort((left, right) => right.datetime - left.datetime);

    const pastMatches = [];
    for (const game of pastSetunGames) {
    const gameId = game.gameId;
    const isHome = game.homeTeamId === options.teamId;
    const statisticUrl = gameId > 0 ? `https://shlmos.ru/game/${gameId}/statistic` : null;
    const mediaPageUrl = gameId > 0 ? `https://shlmos.ru/game/${gameId}/media` : null;

    let mediaUrl = null;
    try {
      const mediaItems = normalizeArray(await fetchJson(buildUrl(`/tournament_game/${gameId}/media/`)));
      const videoItem = mediaItems.find((item) => String(item?.video_url || "").trim());
      if (videoItem) {
        mediaUrl = resolveWebUrl(videoItem.video_url);
      } else {
        const photoItem = mediaItems.find((item) => {
          return [item?.detail_photo?.path, item?.original_photo?.path, item?.list_photo?.path].some((path) => String(path || "").trim());
        });
        if (photoItem?.detail_photo?.path) mediaUrl = resolveWebUrl(photoItem.detail_photo.path);
        else if (photoItem?.original_photo?.path) mediaUrl = resolveWebUrl(photoItem.original_photo.path);
        else if (photoItem?.list_photo?.path) mediaUrl = resolveWebUrl(photoItem.list_photo.path);
      }
    } catch {
      mediaUrl = null;
    }

    pastMatches.push({
      gameId,
      home: game.home,
      away: game.away,
      date: game.date,
      time: game.time,
      venue: isHome ? "home" : "away",
      status: game.status,
      tour: game.tour,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      statisticUrl,
      mediaPageUrl,
      mediaUrl: mediaUrl || mediaPageUrl,
    });

      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    const finishedGames = games.filter((game) => new Date(String(game?.datetime || "")).getTime() <= now.getTime());
    const userStatsMap = new Map();

    for (const game of finishedGames) {
    const gameId = toInt(game?.id);
    if (gameId <= 0) continue;

    const [gameUsersRaw, gameStatsRaw] = await Promise.all([
      fetchJson(buildUrl(`/tournament_game/${gameId}/users/`)).catch(() => []),
      fetchJson(buildUrl(`/tournament_hockey_game/${gameId}/user_statistic/`)).catch(() => []),
    ]);

    const gameUsers = normalizeArray(gameUsersRaw);
    const gameStats = normalizeArray(gameStatsRaw);

    if (!gameUsers.length || !gameStats.length) {
      continue;
    }

    const usersByGameUserId = new Map();
    for (const entry of gameUsers) {
      const gameUserId = toInt(entry?.id);
      if (gameUserId <= 0) continue;

      const teamIdFromUser = toInt(entry?.team_user?.team_id);
      const teamName = teamsByTeamId.get(teamIdFromUser)?.name || entry?.tournament_team?.name || "Команда";

      usersByGameUserId.set(gameUserId, {
        userId: toInt(entry?.team_user?.user?.id),
        teamId: teamIdFromUser,
        team: String(teamName),
        player: getPlayerNameFromUser(entry),
        birth: getBirthDateFromUser(entry),
      });
    }

    for (const stat of gameStats) {
      const gameUserId = toInt(stat?.game_user_id);
      const userInfo = usersByGameUserId.get(gameUserId);
      if (!userInfo || userInfo.userId <= 0) {
        continue;
      }

      const goals = toInt(stat?.ev_goals) + toInt(stat?.pp_goals) + toInt(stat?.sh_goals) + toInt(stat?.shootout_goals);
      const points = toInt(stat?.points);
      const assists = Math.max(0, points - goals);
      const key = String(userInfo.userId);

      if (!userStatsMap.has(key)) {
        userStatsMap.set(key, {
          userId: userInfo.userId,
          player: userInfo.player,
          teamId: userInfo.teamId,
          team: userInfo.team,
          group: divisionLabel,
          games: 0,
          goals: 0,
          assists: 0,
          points: 0,
          birth: userInfo.birth,
        });
      }

      const agg = userStatsMap.get(key);
      agg.games += 1;
      agg.goals += goals;
      agg.assists += assists;
      agg.points += points;
    }

      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    const players = [...userStatsMap.values()]
      .sort((left, right) => {
        const byGoals = toInt(right.goals) - toInt(left.goals);
        if (byGoals !== 0) return byGoals;
        const byGames = toInt(right.games) - toInt(left.games);
        if (byGames !== 0) return byGames;
        return String(left.player).localeCompare(String(right.player), "ru");
      })
      .map((item) => ({
        player: String(item.player),
        group: String(item.group),
        team: String(item.team),
        games: toInt(item.games),
        goals: toInt(item.goals),
      }));

    const setunUsers = normalizeArray(await fetchJson(buildUrl(`/tournament_team/${ownTournamentTeamId}/users/`)));
    const birthdayMap = new Map();

    for (const entry of setunUsers) {
      const name = getPlayerNameFromUser(entry);
      const birth = getBirthDateFromUser(entry);
      if (!name || !birth) continue;

      const key = `${name}|${birth}`;
      if (!birthdayMap.has(key)) {
        birthdayMap.set(key, { name, date: birth });
      }
    }

    const birthdays = [...birthdayMap.values()].sort((left, right) => {
      const [, leftM, leftD] = String(left.date).split("-").map((part) => Number(part));
      const [, rightM, rightD] = String(right.date).split("-").map((part) => Number(part));
      const md = leftM - rightM;
      if (md !== 0) return md;
      const dd = leftD - rightD;
      if (dd !== 0) return dd;
      return String(left.name).localeCompare(String(right.name), "ru");
    });

    const setunStanding = standings.find((row) => row.isOwn) || null;
    const appData = {
      meta: {
        teamName: ownTeamName,
        seasonLabel: SEASON_LABEL,
        seasonId: options.seasonId,
        tournamentId: options.tournamentId,
        division: divisionLabel,
        city: cityName,
        league: "SHL",
        logoUrl,
        teamUrl: TEAM_PAGE_URL(options.teamId),
        sourceHost: "mtgame.ru",
        sourceSite: "shlmos.ru",
        updatedAt: isoNowNoMillis(),
      },
      overview: {
        place: setunStanding ? setunStanding.place : null,
        totalTeams: standings.length,
        games: setunStanding ? setunStanding.games : null,
        wins: setunStanding ? setunStanding.wins : null,
        losses: setunStanding ? setunStanding.losses : null,
        draws: setunStanding ? setunStanding.draws : null,
        goalsFor: setunStanding ? setunStanding.gf : null,
        goalsAgainst: setunStanding ? setunStanding.ga : null,
        goalDiff: setunStanding ? setunStanding.diff : null,
        points: setunStanding ? setunStanding.points : null,
        ppg:
          setunStanding && setunStanding.games > 0
            ? Math.round((setunStanding.points / setunStanding.games) * 100) / 100
            : 0,
      },
      standings,
      matches: upcomingMatches,
      upcomingMatches,
      pastMatches,
      allUpcomingMatches,
      allPastMatches,
      players,
      birthdays,
    };

    const validation = validateFreshData(appData, previousData, options);
    if (!validation.ok) {
      throw new Error(`Generated data validation failed: ${validation.reason}`);
    }

    await writeDataFiles(options, appData);

    console.log(`Tournament: ${options.tournamentId} (${String(tournament?.name || "")})`);
    console.log(`Team: ${ownTeamName} (teamId=${options.teamId}, tournamentTeamId=${ownTournamentTeamId})`);
    console.log(`Standings rows: ${standings.length}`);
    console.log(`All tournament games loaded: ${allGames.length}`);
    console.log(`All upcoming matches exported: ${allUpcomingMatches.length}`);
    console.log(`All past matches exported: ${allPastMatches.length}`);
    console.log(`Setun upcoming matches exported: ${upcomingMatches.length}`);
    console.log(`Setun past matches exported: ${pastMatches.length}`);
    console.log(`Players exported: ${players.length}`);
    console.log(`Birthdays exported: ${birthdays.length}`);
    console.log(`JSON: ${options.outputJson}`);
    console.log(`JS:   ${options.outputJs}`);
  } catch (error) {
    if (previousData) {
      await writeDataFiles(options, previousData);
      console.warn("API data is unavailable or invalid. Fallback to previous data file.");
      console.warn(error && error.message ? error.message : String(error));
      console.log(`JSON: ${options.outputJson}`);
      console.log(`JS:   ${options.outputJs}`);
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
