#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const OUTPUT_FILE_DEFAULT = "all_2016_players_season5.js";
const FETCH_TIMEOUT_MS = 12000;
const MIN_VALID_ROWS = 20;
const MIN_VALID_RATIO = 0.6;

function parseArgs(argv) {
  const options = {
    seasonId: 5,
    delayMs: 120,
    outputJs: OUTPUT_FILE_DEFAULT,
  };

  const readValue = (flag, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seasonId") {
      options.seasonId = Number.parseInt(readValue(arg, i), 10);
      i += 1;
      continue;
    }
    if (arg === "--delayMs") {
      options.delayMs = Number.parseInt(readValue(arg, i), 10);
      i += 1;
      continue;
    }
    if (arg === "--outputJs") {
      options.outputJs = readValue(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.seasonId) || options.seasonId <= 0) {
    throw new Error("seasonId must be a positive integer");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("delayMs must be a non-negative integer");
  }

  resolveSafeOutputPath(options.outputJs);

  return options;
}

function printHelp() {
  console.log("Usage: node update_fhm_2016_stats.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --seasonId <number>     Season id (default: 5)");
  console.log("  --delayMs <number>      Delay between teams in ms (default: 120)");
  console.log("  --outputJs <path>       JS output path");
}

async function sleep(ms) {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toArray(value) {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

async function fetchWithRetry(url, init, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      await sleep(350 * attempt);
    }
  }

  throw new Error("Unreachable");
}

function invokeFhmPost(uri, body, retries = 3) {
  return fetchWithRetry(
    uri,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    retries,
  );
}

function invokeFhmGet(uri, retries = 3) {
  return fetchWithRetry(
    uri,
    {
      method: "GET",
    },
    retries,
  );
}

const TEAM_YEAR_SUFFIX = /\s*2016$/;

function normalizeTeamName(value) {
  return String(value ?? "").replace(TEAM_YEAR_SUFFIX, "").trim();
}

function extractPlayerRows(players, groupName, teamName) {
  const rows = [];

  for (const player of players) {
    const statistics = player?.statistics ?? null;
    const games = Number.isFinite(Number(statistics?.gamesCount)) ? Number(statistics.gamesCount) : 0;
    const goals = Number.isFinite(Number(statistics?.totalGoals)) ? Number(statistics.totalGoals) : 0;

    rows.push({
      player: String(player?.fullName ?? ""),
      group: groupName,
      team: teamName,
      games,
      goals,
    });
  }

  return rows;
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return false;
  }

  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      return false;
    }
    if (typeof row.player !== "string" || typeof row.group !== "string" || typeof row.team !== "string") {
      return false;
    }
    if (!Number.isInteger(row.games) || !Number.isInteger(row.goals)) {
      return false;
    }
  }

  return true;
}

function resolveSafeOutputPath(outputPath) {
  const rootPath = path.resolve(process.cwd());
  const resolvedPath = path.resolve(outputPath);
  const relative = path.relative(rootPath, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside workspace: ${outputPath}`);
  }
  if (path.extname(resolvedPath).toLowerCase() !== ".js") {
    throw new Error("outputJs must point to a .js file");
  }

  return resolvedPath;
}

function sanitizeRows(rows) {
  const cleaned = [];
  let dropped = 0;

  for (const row of rows) {
    const player = String(row?.player ?? "").trim();
    const group = String(row?.group ?? "").trim();
    const team = String(row?.team ?? "").trim();
    const games = Number(row?.games);
    const goals = Number(row?.goals);

    const isValid =
      player.length > 0 &&
      player.length <= 200 &&
      group.length > 0 &&
      group.length <= 120 &&
      team.length > 0 &&
      team.length <= 120 &&
      Number.isInteger(games) &&
      Number.isInteger(goals) &&
      games >= 0 &&
      games <= 200 &&
      goals >= 0 &&
      goals <= 1000;

    if (!isValid) {
      dropped += 1;
      continue;
    }

    cleaned.push({ player, group, team, games, goals });
  }

  const validRatio = rows.length > 0 ? cleaned.length / rows.length : 0;
  if (dropped > 0) {
    console.warn(`Dropped invalid rows: ${dropped}/${rows.length}`);
  }
  if (cleaned.length < MIN_VALID_ROWS || validRatio < MIN_VALID_RATIO) {
    throw new Error(
      `Refusing to overwrite output file: valid rows ${cleaned.length}/${rows.length} are below threshold`,
    );
  }

  return cleaned;
}

async function writeOutput(outputJs, rows) {
  const json = JSON.stringify(rows, null, 2);
  const js = `window.playerGoalsData = ${json};`;

  const jsPath = resolveSafeOutputPath(outputJs);
  await fs.mkdir(path.dirname(jsPath), { recursive: true });

  await fs.writeFile(jsPath, js, "utf8");

  return jsPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const targetTournamentGroups = [
    { tournamentId: 51, groupIds: [312, 315] },
    { tournamentId: 48, groupIds: [309] },
  ];

  const tournaments = toArray(
    await invokeFhmPost("https://fhmoscow.com/api/filter/tournament", {
      season: options.seasonId,
    }),
  );

  const teams = [];

  for (const target of targetTournamentGroups) {
    const tournamentId = Number(target.tournamentId);
    const tournament = tournaments.find((item) => Number(item?.id) === tournamentId);

    if (!tournament) {
      throw new Error(`Tournament ${tournamentId} not found in season ${options.seasonId}`);
    }

    const stages = toArray(
      await invokeFhmPost("https://fhmoscow.com/api/filter/stage", {
        tournament: tournamentId,
      }),
    );

    let stage = stages.find((item) => item?.current === true);
    if (!stage) {
      stage = stages.find((item) => item?.transition !== true);
    }

    if (!stage) {
      throw new Error(`No stage found for tournament ${tournamentId} (${String(tournament?.name ?? "")})`);
    }

    const groups = toArray(
      await invokeFhmPost("https://fhmoscow.com/api/filter/group", {
        stage: Number(stage.id),
      }),
    );

    for (const groupId of target.groupIds) {
      const group = groups.find((item) => Number(item?.id) === Number(groupId));
      if (!group) {
        throw new Error(`Group ${groupId} not found in tournament ${tournamentId} (${String(tournament?.name ?? "")})`);
      }

      const groupTeams = toArray(
        await invokeFhmPost("https://fhmoscow.com/api/filter/team", {
          group: Number(group.id),
        }),
      );

      for (const team of groupTeams) {
        teams.push({
          id: Number(team?.id),
          shortName: team && Object.hasOwn(team, "shortName") ? String(team.shortName ?? "") : "",
          name: team && Object.hasOwn(team, "name") ? String(team.name ?? "") : "",
          groupName: String(group?.name ?? ""),
          tournament: String(tournament?.name ?? ""),
        });
      }
    }
  }

  const uniqueTeams = [...new Map(teams.map((team) => [team.id, team])).values()];
  const rows = [];

  for (let index = 0; index < uniqueTeams.length; index += 1) {
    const team = uniqueTeams[index];
    const teamId = Number(team.id);
    const teamNameRaw = String(team.shortName || "").trim() === "" ? String(team.name ?? "") : String(team.shortName ?? "");
    const teamName = normalizeTeamName(teamNameRaw);
    const groupName = String(team.groupName ?? "");

    console.log(`[${index + 1}/${uniqueTeams.length}] ${teamName} [${groupName}]`);

    const rosterResponse = await invokeFhmGet(
      `https://fhmoscow.com/api/team/${teamId}/player?season=${options.seasonId}`,
    );

    const players = Array.isArray(rosterResponse) ? rosterResponse : toArray(rosterResponse?.value);
    rows.push(...extractPlayerRows(players, groupName, teamName));

    if (options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  rows.sort((a, b) => {
    if (b.goals !== a.goals) {
      return b.goals - a.goals;
    }
    if (b.games !== a.games) {
      return b.games - a.games;
    }
    return a.player.localeCompare(b.player, "ru");
  });

  if (!validateRows(rows)) {
    throw new Error("Refusing to overwrite output file: API result is empty or invalid.");
  }

  const sanitizedRows = sanitizeRows(rows);

  const jsPath = await writeOutput(options.outputJs, sanitizedRows);

  console.log("");
  console.log(`Teams processed: ${uniqueTeams.length}`);
  console.log(`Player rows: ${sanitizedRows.length}`);
  console.log(`JS:   ${jsPath}`);
  console.log("");

  for (const row of sanitizedRows.slice(0, 10)) {
    console.log(`${row.player} | ${row.group} | ${row.team} | games: ${row.games} | goals: ${row.goals}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
