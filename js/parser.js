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
