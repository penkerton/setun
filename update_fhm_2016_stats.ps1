param(
  [int]$SeasonId = 5,
  [int]$DelayMs = 120,
  [string]$OutputJson = "all_2016_players_season5.json",
  [string]$OutputJs = "all_2016_players_season5.js"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-FhmPost {
  param(
    [string]$Uri,
    [hashtable]$Body,
    [int]$Retries = 3
  )

  for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    try {
      $payload = $Body | ConvertTo-Json -Compress
      return Invoke-RestMethod -Uri $Uri -Method Post -ContentType "application/json" -Body $payload
    }
    catch {
      if ($attempt -ge $Retries) {
        throw
      }
      Start-Sleep -Milliseconds (350 * $attempt)
    }
  }
}

function Invoke-FhmGet {
  param(
    [string]$Uri,
    [int]$Retries = 3
  )

  for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    try {
      return Invoke-RestMethod -Uri $Uri -Method Get
    }
    catch {
      if ($attempt -ge $Retries) {
        throw
      }
      Start-Sleep -Milliseconds (350 * $attempt)
    }
  }
}

function ConvertTo-Array {
  param($Value)

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [array]) {
    return @($Value)
  }

  return @($Value)
}

$targetTournamentGroups = @(
  [pscustomobject]@{
    TournamentId = 51
    GroupIds     = @(312, 315)
  },
  [pscustomobject]@{
    TournamentId = 48
    GroupIds     = @(309)
  }
)

$tournaments = ConvertTo-Array (Invoke-FhmPost -Uri "https://fhmoscow.com/api/filter/tournament" -Body @{
  season = $SeasonId
})

$teams = @()

foreach ($target in $targetTournamentGroups) {
  $tournamentId = [int]$target.TournamentId
  $tournament = $tournaments | Where-Object { [int]$_.id -eq $tournamentId } | Select-Object -First 1
  if ($null -eq $tournament) {
    throw ("Tournament {0} not found in season {1}" -f $tournamentId, $SeasonId)
  }

  $stages = ConvertTo-Array (Invoke-FhmPost -Uri "https://fhmoscow.com/api/filter/stage" -Body @{
    tournament = $tournamentId
  })

  $stage = $stages | Where-Object { $_.current -eq $true } | Select-Object -First 1
  if ($null -eq $stage) {
    $stage = $stages | Where-Object { $_.transition -ne $true } | Select-Object -First 1
  }
  if ($null -eq $stage) {
    throw ("No stage found for tournament {0} ({1})" -f $tournamentId, $tournament.name)
  }

  $groups = ConvertTo-Array (Invoke-FhmPost -Uri "https://fhmoscow.com/api/filter/group" -Body @{
    stage = [int]$stage.id
  })

  foreach ($groupId in $target.GroupIds) {
    $group = $groups | Where-Object { [int]$_.id -eq [int]$groupId } | Select-Object -First 1
    if ($null -eq $group) {
      throw ("Group {0} not found in tournament {1} ({2})" -f $groupId, $tournamentId, $tournament.name)
    }

    $groupTeams = ConvertTo-Array (Invoke-FhmPost -Uri "https://fhmoscow.com/api/filter/team" -Body @{
      group = [int]$group.id
    })

    foreach ($team in $groupTeams) {
      $teamShortName = if ($team.PSObject.Properties.Name -contains "shortName") { [string]$team.shortName } else { "" }
      $teamFullName = if ($team.PSObject.Properties.Name -contains "name") { [string]$team.name } else { "" }

      $teams += [pscustomobject]@{
        id         = [int]$team.id
        shortName  = $teamShortName
        name       = $teamFullName
        groupName  = [string]$group.name
        tournament = [string]$tournament.name
      }
    }
  }
}

$teams = $teams | Group-Object id | ForEach-Object { $_.Group | Select-Object -First 1 }

$rows = @()

for ($index = 0; $index -lt $teams.Count; $index++) {
  $team = $teams[$index]
  $teamId = [int]$team.id
  $teamName = if ([string]::IsNullOrWhiteSpace([string]$team.shortName)) { [string]$team.name } else { [string]$team.shortName }
  $groupName = [string]$team.groupName
  Write-Host ("[{0}/{1}] {2} [{3}]" -f ($index + 1), $teams.Count, $teamName, $groupName)

  $rosterResponse = Invoke-FhmGet -Uri ("https://fhmoscow.com/api/team/{0}/player?season={1}" -f $teamId, $SeasonId)
  $players = if ($rosterResponse -is [array]) { @($rosterResponse) } else { @($rosterResponse.value) }

  foreach ($player in $players) {
    $games = 0
    $goals = 0

    if ($null -ne $player.statistics) {
      if ($player.statistics.PSObject.Properties.Name -contains "gamesCount") {
        $games = [int]$player.statistics.gamesCount
      }
      if ($player.statistics.PSObject.Properties.Name -contains "totalGoals") {
        $goals = [int]$player.statistics.totalGoals
      }
    }

    $rows += [pscustomobject]@{
      player = [string]$player.fullName
      group  = $groupName
      team   = $teamName
      games  = $games
      goals  = $goals
    }
  }

  if ($DelayMs -gt 0) {
    Start-Sleep -Milliseconds $DelayMs
  }
}

$rows = $rows | Sort-Object @{ Expression = "goals"; Descending = $true }, @{ Expression = "games"; Descending = $true }, @{ Expression = "player"; Descending = $false }

$json = $rows | ConvertTo-Json -Depth 4
Set-Content -Path $OutputJson -Value $json -Encoding utf8
Set-Content -Path $OutputJs -Value ("window.playerGoalsData = " + $json + ";") -Encoding utf8

Write-Host ""
Write-Host ("Teams processed: {0}" -f $teams.Count)
Write-Host ("Player rows: {0}" -f $rows.Count)
Write-Host ("JSON: {0}" -f (Resolve-Path $OutputJson))
Write-Host ("JS:   {0}" -f (Resolve-Path $OutputJs))
Write-Host ""
$rows | Select-Object -First 10 | Format-Table -AutoSize | Out-String | Write-Host
