param(
  [int]$SeasonId = 230,
  [int]$TournamentId = 4223,
  [int]$TeamId = 2641,
  [string]$DivisionName = "",
  [int]$DelayMs = 60,
  [int]$MatchLimit = 5,
  [string]$OutputJson = "setun_shl_data.json",
  [string]$OutputJs = "setun_shl_data.js"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$apiBase = "https://mtgame.ru/api/v1"
$teamPageUrl = "https://shlmos.ru/team/{0}" -f $TeamId
$seasonLabel = "2026/2027"
$tourSeparator = [char]0x00B7
$tourWord = ([char]0x0442).ToString() + ([char]0x0443) + ([char]0x0440)

$httpHandler = New-Object System.Net.Http.HttpClientHandler
$httpClient = New-Object System.Net.Http.HttpClient($httpHandler)
$httpClient.Timeout = [TimeSpan]::FromSeconds(45)
$httpClient.DefaultRequestHeaders.Accept.Clear()
$null = $httpClient.DefaultRequestHeaders.Accept.Add([System.Net.Http.Headers.MediaTypeWithQualityHeaderValue]::new("application/json"))
$null = $httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("SetunStatsUpdater/1.0")

function ConvertTo-Array {
  param($Value)

  if ($null -eq $Value) { return @() }
  if ($Value -is [array]) { return @($Value) }
  return @($Value)
}

function Invoke-JsonGet {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [int]$Retries = 3
  )

  for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    try {
      $response = $httpClient.GetAsync($Uri).GetAwaiter().GetResult()
      $rawBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      $rawText = [System.Text.Encoding]::UTF8.GetString($rawBytes)

      if (-not $response.IsSuccessStatusCode) {
        throw ("GET {0} failed ({1}): {2}" -f $Uri, [int]$response.StatusCode, $rawText)
      }

      if ([string]::IsNullOrWhiteSpace($rawText)) {
        return $null
      }

      return $rawText | ConvertFrom-Json
    }
    catch {
      if ($attempt -ge $Retries) {
        throw
      }
      Start-Sleep -Milliseconds (300 * $attempt)
    }
  }
}

function Build-Uri {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [hashtable]$Query
  )

  $uri = "{0}{1}" -f $apiBase, $Path
  if ($null -eq $Query -or $Query.Count -eq 0) {
    return $uri
  }

  $parts = @()
  foreach ($key in $Query.Keys) {
    if ($null -eq $Query[$key]) { continue }
    $parts += ("{0}={1}" -f [uri]::EscapeDataString([string]$key), [uri]::EscapeDataString([string]$Query[$key]))
  }

  if ($parts.Count -eq 0) {
    return $uri
  }

  return "{0}?{1}" -f $uri, ($parts -join "&")
}

function To-Int {
  param($Value)

  if ($null -eq $Value) { return 0 }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return 0 }
  $n = 0
  if ([int]::TryParse($text, [ref]$n)) { return $n }
  return 0
}

function To-NullableInt {
  param($Value)

  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  $n = 0
  if ([int]::TryParse($text, [ref]$n)) { return $n }
  return $null
}

function Get-PlayerNameFromUser {
  param($UserEntry)

  $sources = @(
    [pscustomobject]@{ Last = $UserEntry.league_player.last_name; First = $UserEntry.league_player.first_name; Middle = $UserEntry.league_player.middle_name },
    [pscustomobject]@{ Last = $UserEntry.team_user.user.last_name; First = $UserEntry.team_user.user.first_name; Middle = $UserEntry.team_user.user.middle_name },
    [pscustomobject]@{ Last = $UserEntry.last_name; First = $UserEntry.first_name; Middle = $UserEntry.middle_name }
  )

  foreach ($src in $sources) {
    $chunks = @([string]$src.Last, [string]$src.First, [string]$src.Middle) |
      ForEach-Object { $_.Trim() } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    if ($chunks.Count -gt 0) {
      return ($chunks -join " ")
    }
  }

  return "Без имени"
}

function Get-BirthDateFromUser {
  param($UserEntry)

  $candidates = @(
    [string]$UserEntry.league_player.birth_date,
    [string]$UserEntry.team_user.user.birth_date
  )

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    try {
      $dt = [datetime]$candidate
      return $dt.ToString("yyyy-MM-dd")
    }
    catch {
      continue
    }
  }

  return $null
}

function To-MoscowDateTime {
  param([Parameter(Mandatory = $true)][string]$IsoDateTime)

  $dto = [datetimeoffset]::Parse($IsoDateTime)
  $tz = [TimeZoneInfo]::FindSystemTimeZoneById("Russian Standard Time")
  return [TimeZoneInfo]::ConvertTime($dto, $tz)
}

$tournament = Invoke-JsonGet -Uri (Build-Uri -Path ("/tournament/{0}/" -f $TournamentId))
$allTeams = ConvertTo-Array (Invoke-JsonGet -Uri (Build-Uri -Path ("/tournament/{0}/teams/" -f $TournamentId)))
if ($allTeams.Count -eq 0) {
  throw ("No teams found for tournament {0}" -f $TournamentId)
}

$ownTeamRow = $allTeams | Where-Object { (To-Int $_.team.id) -eq $TeamId } | Select-Object -First 1
if ($null -eq $ownTeamRow) {
  throw ("TeamId {0} is not present in tournament {1}" -f $TeamId, $TournamentId)
}

$ownTournamentTeamId = To-Int $ownTeamRow.id
$ownTeamName = [string]$ownTeamRow.name
$logoUrl = [string]$ownTeamRow.logo.path
$divisionLabel = if ([string]::IsNullOrWhiteSpace($DivisionName)) { [string]$tournament.name } else { $DivisionName }
$cityName = if ($ownTeamRow.team -and $ownTeamRow.team.city -and $ownTeamRow.team.city.name) { [string]$ownTeamRow.team.city.name } else { "" }

$teamsByTeamId = @{}
$teamsByTournamentTeamId = @{}
foreach ($row in $allTeams) {
  $teamIdKey = To-Int $row.team.id
  $ttIdKey = To-Int $row.id
  if ($teamIdKey -gt 0) {
    $teamsByTeamId[$teamIdKey] = $row
  }
  if ($ttIdKey -gt 0) {
    $teamsByTournamentTeamId[$ttIdKey] = $row
  }
}

$standings = @()
$standingsSorted = $allTeams |
  Sort-Object @{ Expression = { To-Int $_.points }; Descending = $true },
               @{ Expression = { To-Int $_.score_sum - To-Int $_.missed_sum }; Descending = $true },
               @{ Expression = { To-Int $_.score_sum }; Descending = $true },
               @{ Expression = { [string]$_.name }; Descending = $false }

for ($i = 0; $i -lt $standingsSorted.Count; $i++) {
  $row = $standingsSorted[$i]
  $gf = To-Int $row.score_sum
  $ga = To-Int $row.missed_sum
  $standings += [pscustomobject]@{
    place = $i + 1
    team = [string]$row.name
    games = To-Int $row.games_count
    wins = To-Int $row.won_games_count
    draws = To-Int $row.draw_games_count
    losses = To-Int $row.lose_games_count
    gf = $gf
    ga = $ga
    diff = $gf - $ga
    points = To-Int $row.points
    isOwn = ((To-Int $row.team.id) -eq $TeamId)
  }
}

$games = @()
$page = 1
$pageSize = 100
while ($true) {
  $uri = Build-Uri -Path ("/tournament/{0}/games/" -f $TournamentId) -Query @{
    page = $page
    size = $pageSize
  }

  $chunk = ConvertTo-Array (Invoke-JsonGet -Uri $uri)
  if ($chunk.Count -eq 0) {
    break
  }

  $games += $chunk
  if ($chunk.Count -lt $pageSize) {
    break
  }

  $page += 1
  if ($DelayMs -gt 0) {
    Start-Sleep -Milliseconds $DelayMs
  }
}

if ($games.Count -eq 0) {
  throw ("No games found for tournament {0}" -f $TournamentId)
}

$nowUtc = [datetimeoffset]::UtcNow
$setunGames = $games |
  Where-Object { ((To-Int $_.team_id) -eq $TeamId) -or ((To-Int $_.competitor_team_id) -eq $TeamId) } |
  Sort-Object { [datetimeoffset]::Parse([string]$_.datetime) }

$upcomingSetunGames = $setunGames | Where-Object { [datetimeoffset]::Parse([string]$_.datetime) -ge $nowUtc }
if ($upcomingSetunGames.Count -gt 0) {
  $upcomingSetunGames = $upcomingSetunGames | Select-Object -First $MatchLimit
}

$upcomingMatches = @()
foreach ($game in $upcomingSetunGames) {
  $local = To-MoscowDateTime -IsoDateTime ([string]$game.datetime)
  $homeName = if ($game.team -and $game.team.name) { [string]$game.team.name } else { [string]$game.team_name }
  $awayName = if ($game.competitor_team -and $game.competitor_team.name) { [string]$game.competitor_team.name } else { [string]$game.competitor_team_name }
  $isHome = ((To-Int $game.team_id) -eq $TeamId)

  $upcomingMatches += [pscustomobject]@{
    gameId = To-Int $game.id
    home = $homeName
    away = $awayName
    date = $local.ToString("yyyy-MM-dd")
    time = $local.ToString("HH:mm")
    venue = if ($isHome) { "home" } else { "away" }
    status = [string]$game.status
    tour = if ($null -ne $game.tournament_tour) { "SHL {0} {1} {2} {3}" -f $divisionLabel, $tourSeparator, (To-Int $game.tournament_tour), $tourWord } else { "SHL {0}" -f $divisionLabel }
  }
}

$pastSetunGames = $setunGames |
  Where-Object { [datetimeoffset]::Parse([string]$_.datetime) -lt $nowUtc } |
  Sort-Object { [datetimeoffset]::Parse([string]$_.datetime) } -Descending

$pastMatches = @()
foreach ($game in $pastSetunGames) {
  $local = To-MoscowDateTime -IsoDateTime ([string]$game.datetime)
  $homeName = if ($game.team -and $game.team.name) { [string]$game.team.name } else { [string]$game.team_name }
  $awayName = if ($game.competitor_team -and $game.competitor_team.name) { [string]$game.competitor_team.name } else { [string]$game.competitor_team_name }
  $isHome = ((To-Int $game.team_id) -eq $TeamId)
  $mediaUrl = $null

  try {
    $mediaItems = ConvertTo-Array (Invoke-JsonGet -Uri (Build-Uri -Path ("/tournament_game/{0}/media/" -f (To-Int $game.id))))
    if ($mediaItems.Count -gt 0) {
      $videoItem = $mediaItems | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.video_url) } | Select-Object -First 1
      if ($videoItem) {
        $mediaUrl = [string]$videoItem.video_url
      }
      else {
        $photoItem = $mediaItems | Where-Object {
          ($_.detail_photo -and -not [string]::IsNullOrWhiteSpace([string]$_.detail_photo.path)) -or
          ($_.original_photo -and -not [string]::IsNullOrWhiteSpace([string]$_.original_photo.path)) -or
          ($_.list_photo -and -not [string]::IsNullOrWhiteSpace([string]$_.list_photo.path))
        } | Select-Object -First 1

        if ($photoItem) {
          if ($photoItem.detail_photo -and -not [string]::IsNullOrWhiteSpace([string]$photoItem.detail_photo.path)) {
            $mediaUrl = [string]$photoItem.detail_photo.path
          }
          elseif ($photoItem.original_photo -and -not [string]::IsNullOrWhiteSpace([string]$photoItem.original_photo.path)) {
            $mediaUrl = [string]$photoItem.original_photo.path
          }
          elseif ($photoItem.list_photo -and -not [string]::IsNullOrWhiteSpace([string]$photoItem.list_photo.path)) {
            $mediaUrl = [string]$photoItem.list_photo.path
          }
        }
      }
    }
  }
  catch {
    $mediaUrl = $null
  }

  $pastMatches += [pscustomobject]@{
    gameId = To-Int $game.id
    home = $homeName
    away = $awayName
    date = $local.ToString("yyyy-MM-dd")
    time = $local.ToString("HH:mm")
    venue = if ($isHome) { "home" } else { "away" }
    status = [string]$game.status
    tour = if ($null -ne $game.tournament_tour) { "SHL {0} {1} {2} {3}" -f $divisionLabel, $tourSeparator, (To-Int $game.tournament_tour), $tourWord } else { "SHL {0}" -f $divisionLabel }
    homeScore = To-NullableInt $game.team_score
    awayScore = To-NullableInt $game.competitor_team_score
    mediaUrl = $mediaUrl
  }

  if ($DelayMs -gt 0) {
    Start-Sleep -Milliseconds $DelayMs
  }
}

$finishedGames = $games | Where-Object {
  [datetimeoffset]::Parse([string]$_.datetime) -le $nowUtc
}

$userStatsMap = @{}

foreach ($game in $finishedGames) {
  $gameId = To-Int $game.id
  if ($gameId -le 0) { continue }

  $usersUri = Build-Uri -Path ("/tournament_game/{0}/users/" -f $gameId)
  $statsUri = Build-Uri -Path ("/tournament_hockey_game/{0}/user_statistic/" -f $gameId)

  $gameUsers = ConvertTo-Array (Invoke-JsonGet -Uri $usersUri)
  $gameStats = ConvertTo-Array (Invoke-JsonGet -Uri $statsUri)

  if ($gameUsers.Count -eq 0 -or $gameStats.Count -eq 0) {
    continue
  }

  $usersByGameUserId = @{}
  foreach ($entry in $gameUsers) {
    $gameUserId = To-Int $entry.id
    if ($gameUserId -le 0) { continue }

    $teamIdFromUser = To-Int $entry.team_user.team_id
    $teamName = if ($teamsByTeamId.ContainsKey($teamIdFromUser)) {
      [string]$teamsByTeamId[$teamIdFromUser].name
    }
    elseif ($entry.tournament_team -and $entry.tournament_team.name) {
      [string]$entry.tournament_team.name
    }
    else {
      "Команда"
    }

    $usersByGameUserId[$gameUserId] = [pscustomobject]@{
      userId = To-Int $entry.team_user.user.id
      teamId = $teamIdFromUser
      team = $teamName
      player = Get-PlayerNameFromUser -UserEntry $entry
      birth = Get-BirthDateFromUser -UserEntry $entry
    }
  }

  foreach ($stat in $gameStats) {
    $gameUserId = To-Int $stat.game_user_id
    if (-not $usersByGameUserId.ContainsKey($gameUserId)) {
      continue
    }

    $userInfo = $usersByGameUserId[$gameUserId]
    if ($userInfo.userId -le 0) {
      continue
    }

    $goals = (To-Int $stat.ev_goals) + (To-Int $stat.pp_goals) + (To-Int $stat.sh_goals) + (To-Int $stat.shootout_goals)
    $points = To-Int $stat.points
    $assists = [Math]::Max(0, $points - $goals)
    $key = [string]$userInfo.userId

    if (-not $userStatsMap.ContainsKey($key)) {
      $userStatsMap[$key] = [pscustomobject]@{
        userId = $userInfo.userId
        player = $userInfo.player
        teamId = $userInfo.teamId
        team = $userInfo.team
        group = $divisionLabel
        games = 0
        goals = 0
        assists = 0
        points = 0
        birth = $userInfo.birth
      }
    }

    $agg = $userStatsMap[$key]
    $agg.games += 1
    $agg.goals += $goals
    $agg.assists += $assists
    $agg.points += $points
  }

  if ($DelayMs -gt 0) {
    Start-Sleep -Milliseconds $DelayMs
  }
}

$players = @($userStatsMap.Values) |
  Sort-Object @{ Expression = { To-Int $_.goals }; Descending = $true },
               @{ Expression = { To-Int $_.games }; Descending = $true },
               @{ Expression = { [string]$_.player }; Descending = $false } |
  ForEach-Object {
    [pscustomobject]@{
      player = [string]$_.player
      group = [string]$_.group
      team = [string]$_.team
      games = To-Int $_.games
      goals = To-Int $_.goals
    }
  }

$setunUsers = ConvertTo-Array (Invoke-JsonGet -Uri (Build-Uri -Path ("/tournament_team/{0}/users/" -f $ownTournamentTeamId)))
$birthdayMap = @{}
foreach ($entry in $setunUsers) {
  $name = Get-PlayerNameFromUser -UserEntry $entry
  $birth = Get-BirthDateFromUser -UserEntry $entry
  if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($birth)) {
    continue
  }

  $key = "{0}|{1}" -f $name, $birth
  if (-not $birthdayMap.ContainsKey($key)) {
    $birthdayMap[$key] = [pscustomobject]@{
      name = $name
      date = $birth
    }
  }
}

$birthdays = @($birthdayMap.Values) |
  Sort-Object @{ Expression = { [datetime]::ParseExact($_.date, "yyyy-MM-dd", $null).Month } },
               @{ Expression = { [datetime]::ParseExact($_.date, "yyyy-MM-dd", $null).Day } },
               @{ Expression = { [string]$_.name } }

$setunStanding = $standings | Where-Object { $_.isOwn } | Select-Object -First 1
$updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$appData = [pscustomobject]@{
  meta = [pscustomobject]@{
    teamName = $ownTeamName
    seasonLabel = $seasonLabel
    seasonId = $SeasonId
    tournamentId = $TournamentId
    division = $divisionLabel
    city = $cityName
    league = "SHL"
    logoUrl = $logoUrl
    teamUrl = $teamPageUrl
    sourceHost = "mtgame.ru"
    sourceSite = "shlmos.ru"
    updatedAt = $updatedAt
  }
  overview = [pscustomobject]@{
    place = if ($setunStanding) { $setunStanding.place } else { $null }
    totalTeams = $standings.Count
    games = if ($setunStanding) { $setunStanding.games } else { $null }
    wins = if ($setunStanding) { $setunStanding.wins } else { $null }
    losses = if ($setunStanding) { $setunStanding.losses } else { $null }
    draws = if ($setunStanding) { $setunStanding.draws } else { $null }
    goalsFor = if ($setunStanding) { $setunStanding.gf } else { $null }
    goalsAgainst = if ($setunStanding) { $setunStanding.ga } else { $null }
    goalDiff = if ($setunStanding) { $setunStanding.diff } else { $null }
    points = if ($setunStanding) { $setunStanding.points } else { $null }
    ppg = if ($setunStanding -and $setunStanding.games -gt 0) { [Math]::Round(($setunStanding.points / $setunStanding.games), 2) } else { 0 }
  }
  standings = $standings
  matches = $upcomingMatches
  upcomingMatches = $upcomingMatches
  pastMatches = $pastMatches
  players = $players
  birthdays = $birthdays
}

$json = $appData | ConvertTo-Json -Depth 100
Set-Content -Path $OutputJson -Value $json -Encoding utf8

$js = @(
  "window.shlAppData = $json;",
  "window.playerGoalsData = window.shlAppData.players;"
) -join "`r`n"
Set-Content -Path $OutputJs -Value $js -Encoding utf8

Write-Host ""
Write-Host ("Tournament: {0} ({1})" -f $TournamentId, $tournament.name)
Write-Host ("Team: {0} (teamId={1}, tournamentTeamId={2})" -f $ownTeamName, $TeamId, $ownTournamentTeamId)
Write-Host ("Standings rows: {0}" -f $standings.Count)
Write-Host ("Upcoming matches exported: {0}" -f $upcomingMatches.Count)
Write-Host ("Past matches exported: {0}" -f $pastMatches.Count)
Write-Host ("Players exported: {0}" -f $players.Count)
Write-Host ("Birthdays exported: {0}" -f $birthdays.Count)
Write-Host ("JSON: {0}" -f (Resolve-Path $OutputJson))
Write-Host ("JS:   {0}" -f (Resolve-Path $OutputJs))
Write-Host ""

$players | Select-Object -First 10 | Format-Table -AutoSize | Out-String | Write-Host
