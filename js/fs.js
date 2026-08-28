// File System Access API: доступ к папке stats и подсчет сегодняшних ранов.
//
// Содержимое CSV не читается вообще, только имена файлов в листинге папки.
// Поэтому скан дешевый (в папке автора 1755 файлов) и его можно гонять
// раз в несколько секунд, чтобы прогресс полз вживую.

import { parseStatsFileName, parseRunContent, isStatsFile } from './parser.js';
import { kvGet, kvSet, kvDel, putParsedRuns, getParsedFileNames } from './db.js';

const HANDLE_KEY = 'statsDirHandle';

export function fsSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickStatsFolder() {
  const handle = await window.showDirectoryPicker({ id: 'kovaaks-stats', mode: 'read' });
  await kvSet(HANDLE_KEY, handle);
  return handle;
}

export async function getStoredFolder() {
  try {
    return (await kvGet(HANDLE_KEY)) || null;
  } catch {
    return null;
  }
}

export async function forgetFolder() {
  await kvDel(HANDLE_KEY);
}

// Handle переживает закрытие вкладки, а вот разрешение нет.
// queryPermission без жеста пользователя вернет 'prompt', requestPermission
// требует клика, поэтому вызывается только из обработчика кнопки.
export async function ensurePermission(handle, { request = false } = {}) {
  if (!handle) return false;
  let state = await handle.queryPermission({ mode: 'read' });
  if (state === 'granted') return true;
  if (request) {
    state = await handle.requestPermission({ mode: 'read' });
    return state === 'granted';
  }
  return false;
}

// Первые часы после полуночи, когда ночные раны еще могут дозакрыть
// вчерашний день (сессия, переехавшая через полночь).
export const GRACE_HOURS = 2;

// Один проход по папке, три корзины: вчерашние раны, ночные сегодняшние
// (первые GRACE_HOURS часов) и остальные сегодняшние.
export async function countRunsAroundMidnight(handle, today, prevDate) {
  const prev = new Map();
  const grace = new Map();
  const cur = new Map();
  let scanned = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file') continue;
    const name = entry.name;
    if (!name.endsWith('.csv')) continue;
    scanned++;
    const parsed = parseStatsFileName(name);
    if (!parsed) continue;
    if (parsed.date === prevDate) bump(prev, parsed.scenario);
    else if (parsed.date === today) {
      bump(Number(parsed.time.slice(0, 2)) < GRACE_HOURS ? grace : cur, parsed.scenario);
    }
  }
  return { prev, grace, cur, scanned };
}

// Грейс-окно (просьба Pasha 2026-08-28): если вчерашний день НАЧАТ, но не
// закрыт, ночные раны (до GRACE_HOURS) досчитываются во вчера, а не в
// сегодня: сессия, переползшая через полночь, закрывает свой день сама.
// Если вчера закрыт или вообще не начат, ночные раны принадлежат сегодню.
// Чистая функция, тестируется в node без браузера.
export function applyGraceWindow(scenarios, prev, grace, cur) {
  const merge = (a, b) => {
    const m = new Map(a);
    for (const [k, v] of b) m.set(k, (m.get(k) || 0) + v);
    return m;
  };
  const prevAlone = matchPlaylist(scenarios, prev);
  if (!prevAlone.done && prevAlone.completedRuns > 0 && grace.size) {
    return {
      prevProgress: matchPlaylist(scenarios, merge(prev, grace)),
      todayProgress: matchPlaylist(scenarios, cur),
      graceUsed: [...grace.values()].reduce((a, b) => a + b, 0),
    };
  }
  return {
    prevProgress: prevAlone,
    todayProgress: matchPlaylist(scenarios, merge(cur, grace)),
    graceUsed: 0,
  };
}

// Индексация содержимого: парсит еще не разобранные CSV в компактные метрики
// и складывает в IndexedDB. Инкрементальная: после первого прохода по истории
// каждый вызов трогает только новые файлы. Возвращает число добавленных.
let indexing = false;
export async function indexRunContents(handle, onProgress = () => {}) {
  if (indexing) return { added: 0, busy: true };
  indexing = true;
  try {
    const known = await getParsedFileNames();
    const fresh = [];
    for await (const entry of handle.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.csv')) continue;
      if (!isStatsFile(entry.name) || known.has(entry.name)) continue;
      fresh.push(entry);
    }
    let done = 0;
    const batch = [];
    for (const entry of fresh) {
      try {
        const file = await entry.getFile();
        const text = await file.text();
        batch.push(parseRunContent(entry.name, text));
      } catch { /* битый файл пропускаем, попробуем в другой раз не будем */ }
      done++;
      if (batch.length >= 100) await putParsedRuns(batch.splice(0));
      if (done % 50 === 0 || done === fresh.length) onProgress({ done, total: fresh.length });
    }
    if (batch.length) await putParsedRuns(batch);
    return { added: done };
  } finally {
    indexing = false;
  }
}

// Сопоставляет сегодняшние раны с требованиями плейлисты.
// scenarios: [{ name, requiredRuns }]
export function matchPlaylist(scenarios, counts) {
  const items = scenarios.map((s) => {
    const played = counts.get(s.name) || 0;
    return {
      name: s.name,
      required: s.requiredRuns,
      played,
      // засчитываем не больше требуемого, лишние раны в процент не идут
      credited: Math.min(played, s.requiredRuns),
      done: played >= s.requiredRuns,
    };
  });
  const requiredRuns = items.reduce((n, i) => n + i.required, 0);
  const completedRuns = items.reduce((n, i) => n + i.credited, 0);
  return {
    items,
    requiredRuns,
    completedRuns,
    percent: requiredRuns > 0 ? completedRuns / requiredRuns : 0,
    done: requiredRuns > 0 && completedRuns >= requiredRuns,
  };
}
