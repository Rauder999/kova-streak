// Разбор имени файла статистики KovaaK's. Содержимое CSV нам не нужно:
// имя файла уже содержит и сценарий, и время завершения рана.
//
// Формат подтвержден на 1755 реальных файлах из папки stats:
//   {Scenario} - Challenge - YYYY.MM.DD-HH.MM.SS Stats.csv
// Таймстамп это МОМЕНТ ЗАВЕРШЕНИЯ рана (проверено: файл 20.18.33 содержит
// Challenge Start 20:17:31.871), поэтому ран засчитывается в тот день,
// когда игрок его дожал. Время локальное, конвертации не требуется.

const FILENAME_RE = /^(.*) - Challenge - (\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}) Stats\.csv$/;

// Якорь ' - Challenge - ' отделяет имя сценария целиком, поэтому сценарий,
// чье имя является префиксом другого, ложных срабатываний не дает.
export function parseStatsFileName(fileName) {
  const m = FILENAME_RE.exec(fileName);
  if (!m) return null;
  return {
    scenario: m[1],
    date: `${m[2]}-${m[3]}-${m[4]}`,
    time: `${m[5]}:${m[6]}:${m[7]}`,
  };
}

export function isStatsFile(fileName) {
  return FILENAME_RE.test(fileName);
}

// Локальная дата в формате YYYY-MM-DD. Всегда локальная, не UTC:
// день игрока это его календарный день, а не гринвичский.
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localMonth(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// ---------- разбор содержимого CSV (для личной статистики) ----------
// Формат файла: таблица киллов, сводка по оружию, key-value сводка, настройки.
// Парсер адаптирован из AimSama, но хранит не сырые киллы, а метрики рана:
// на 1800+ файлах истории это разница между мегабайтами и килобайтами.

function toNum(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/s$/, '');
  if (t === '' || !/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) return null;
  return parseFloat(t);
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function parseRunContent(fileName, text) {
  const meta = parseStatsFileName(fileName);
  if (!meta) throw new Error('not a stats file: ' + fileName);

  const lines = text.split(/\r?\n/);
  const kills = [];
  const weapons = [];
  const kv = {};
  let section = 'start';
  let killCols = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    if (line.startsWith('Kill #,')) { section = 'kills'; killCols = line.split(','); continue; }
    if (line.startsWith('Weapon,')) { section = 'weapons'; continue; }
    const kvIdx = line.indexOf(':,');
    if (kvIdx > 0 && section !== 'kills') {
      kv[line.slice(0, kvIdx).trim()] = line.slice(kvIdx + 2).trim();
      section = 'kv';
      continue;
    }
    if (section === 'kills') {
      const parts = line.split(',');
      if (!killCols || parts.length < killCols.length) continue;
      // имя бота с запятой сдвигает колонки; лишнее склеиваем в поле Bot
      const extra = parts.length - killCols.length;
      const fixed = extra > 0
        ? [...parts.slice(0, 2), parts.slice(2, 3 + extra).join(','), ...parts.slice(3 + extra)]
        : parts;
      kills.push({ ttk: toNum(fixed[4]), shots: toNum(fixed[5]), hits: toNum(fixed[6]) });
      continue;
    }
    if (section === 'weapons') {
      const parts = line.split(',');
      if (parts.length >= 3 && parts[0]) weapons.push({ shots: toNum(parts[1]) || 0, hits: toNum(parts[2]) || 0 });
    }
  }

  const shots = weapons.reduce((s, w) => s + w.shots, 0);
  const hits = weapons.reduce((s, w) => s + w.hits, 0);
  const ttks = kills.map((k) => k.ttk).filter((t) => t != null && t > 0.05);
  const instantKills = kills.filter((k) => k.ttk != null && k.ttk <= 0.05).length;

  // тип рана определяется по данным, не по имени: у трекинга с бессмертными
  // ботами киллов нет, у кликинга TTK почти нулевые
  let type = 'unknown';
  const ttkMed = median(ttks);
  if (kills.length === 0 && shots > 50) type = 'tracking';
  else if (kills.length > 0 && instantKills / kills.length > 0.5) type = 'clicking';
  else if (kills.length > 0 && ttkMed != null && ttkMed > 2) type = 'tracking';
  else if (kills.length > 0) type = 'switching';

  // динамика точности: первая против второй половины киллов (зажим/усталость)
  let accDrop = null;
  const withShots = kills.filter((k) => k.shots > 0);
  if (withShots.length >= 6) {
    const half = Math.floor(withShots.length / 2);
    const sum = (list, f) => list.reduce((s, k) => s + f(k), 0);
    const a = withShots.slice(0, half);
    const b = withShots.slice(half);
    const accA = sum(a, (k) => k.hits) / Math.max(1, sum(a, (k) => k.shots));
    const accB = sum(b, (k) => k.hits) / Math.max(1, sum(b, (k) => k.shots));
    accDrop = accB - accA; // отрицательное = к концу рана хуже
  }

  // чоки: киллы, на которых застрял (TTK втрое дольше своей же медианы рана)
  const ttkTail = ttks.length >= 8 && ttkMed > 0
    ? ttks.filter((t) => t > ttkMed * 3).length / ttks.length
    : null;

  return {
    fileName,
    scenario: (kv['Scenario'] || meta.scenario).trim(),
    date: meta.date,
    dateTime: `${meta.date}T${meta.time}`,
    type,
    score: toNum(kv['Score']),
    kills: kills.length,
    shots,
    hits,
    accuracy: shots > 0 ? hits / shots : null,
    ttkMed,
    ttkTail,
    accDrop,
    totalOvershots: toNum(kv['Total Overshots']),
    pauseCount: toNum(kv['Pause Count']),
  };
}
