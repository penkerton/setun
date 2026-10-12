# setun

Статический one-page дашборд команды Сетунь (SHL):
- обзор сезона,
- турнирная таблица дивизиона,
- ближайшие матчи,
- статистика игроков по дивизиону,
- дни рождения состава.

Источник данных: SHL/MTGame API.
Целевая страница команды: https://shlmos.ru/team/2641

## Файлы проекта

- `index.html` — интерфейс страницы.
- `update_shl_setun_stats.mjs` — кроссплатформенный скрипт обновления данных для CI/GitHub Actions.
- `setun_shl_data.json` — сгенерированные данные (JSON).
- `setun_shl_data.js` — сгенерированные данные для браузера (`window.shlAppData`).
- `UPDATE_STATS.md` — инструкция по обновлению данных.

## Быстрый старт

1. Установите Node.js (рекомендуется 20+).
2. Откройте папку проекта в терминале.
3. Запустите:

```bash
node ./update_shl_setun_stats.mjs
```

4. Откройте `index.html` в браузере.

## Как работает обновление

Скрипт `update_shl_setun_stats.mjs` автоматически собирает:
- турнирную таблицу дивизиона,
- ближайшие матчи Сетуни,
- статистику игроков по дивизиону,
- дни рождения игроков Сетуни.

Результат сохраняется в:
- `setun_shl_data.json`
- `setun_shl_data.js`

## Параметры скрипта

По умолчанию:
- `seasonId = 230`
- `tournamentId = 4223`
- `teamId = 2641`
- `matchLimit = 5`

Пример с параметрами:

```bash
node ./update_shl_setun_stats.mjs --seasonId 230 --tournamentId 4223 --teamId 2641 --matchLimit 5
```

## Ручное обновление и публикация

1. Обновите данные локально:

```bash
node ./update_shl_setun_stats.mjs
```

2. Проверьте изменения:

```bash
git status
```

3. Закоммитьте data-файлы:

```bash
git add setun_shl_data.json setun_shl_data.js
git commit -m "chore: manual data update"
```

4. Опубликуйте:

```bash
git push
```

После push автоматически сработает деплой на GitHub Pages.

## Автообновление на GitHub

Настроен workflow `.github/workflows/update-data.yml`:
- запускается каждые 6 часов,
- обновляет `setun_shl_data.json` и `setun_shl_data.js`,
- коммитит изменения в `main` при наличии обновлений.

После коммита автоматически срабатывает workflow деплоя GitHub Pages (`.github/workflows/static.yml`).
