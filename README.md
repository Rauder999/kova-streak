# kova-streak

Групповой трекер ежедневных тренировок в KovaaK's. Играешь плейлисту недели,
сайт видит это в папке stats и отмечает день сам. Кнопки "я сделал" нет.

Ранжирование по количеству пропущенных дней, а не по скору: слабый аимер не
проигрывает сильному, выигрывает тот, кто приходит каждый день.

## Как это работает

1. Админ импортирует JSON плейлисты из `FPSAimTrainer\Saved\SaveGames\Playlists`
   и публикует ее в KV. Это единый источник правды для всей группы.
2. Игрок логинится через Discord и один раз за сессию дает доступ к папке
   `FPSAimTrainer\FPSAimTrainer\stats`.
3. Вкладка висит открытой, сайт раз в 5 секунд перечитывает листинг папки,
   считает сегодняшние раны по каждому сценарию и сверяет с `play_Count`.
4. На 100% день автоматически уходит в бэкенд. Частичный прогресс тоже
   отправляется, не чаще раза в минуту, чтобы группа видела, кто на подходе.
5. В 23:00 воркер постит в канал Discord, кто отметился, кто нет и у кого
   стрик под угрозой.

День считается по имени файла: KovaaK's пишет
`{Scenario} - Challenge - YYYY.MM.DD-HH.MM.SS Stats.csv` после КАЖДОГО рана,
и таймстамп это момент завершения. Содержимое CSV не читается вообще,
поэтому скан папки на 1700+ файлов стоит копейки.

## Структура

```
index.html          три вкладки: Today, Group, Admin
css/style.css       токены Obsidian Signal, общие с AIMSOMA
js/parser.js        разбор имени файла статистики, локальные даты
js/fs.js            File System Access API, подсчет ранов, матчинг с плейлистой
js/db.js            IndexedDB, хранит handle папки между сессиями
js/auth.js          сессия Discord
js/api.js           клиент воркера
js/app.js           состояние, поллинг, автоотметка, рендер
worker/             Cloudflare Worker + KV, см. worker/README.md
```

## Запуск локально

```bash
python serve.py 8080
```

File System Access API требует secure context, `localhost` им считается,
а открытый через `file://` файл нет. Только desktop Chrome или Edge.

Чтобы гонять фронт против локального воркера:

```js
localStorage.setItem('kova-streak-api', 'http://127.0.0.1:8787')
```

## Деплой

- Фронт: GitHub Pages, репозиторий `rauder999.github.io/kova-streak`.
- Бэкенд: `cd worker && wrangler deploy`, инструкции и список секретов в
  [worker/README.md](worker/README.md).

Домены, с которых воркер принимает запросы, зашиты в `ALLOWED_ORIGINS`
в `worker/worker.js`.

## Что нужно завести руками до первого запуска

1. Discord-приложение (Client ID, Client Secret, Redirect URI).
2. Вебхук в канале для ежедневного дайджеста.
3. KV namespace.
4. В `worker/wrangler.jsonc` подставить свой Discord ID в `ADMIN_DISCORD_IDS`,
   иначе вкладки Admin не будет ни у кого.

Все шаги по пунктам в [worker/README.md](worker/README.md).
