// File System Access API: доступ к папке stats и подсчет сегодняшних ранов.
//
// Содержимое CSV не читается вообще, только имена файлов в листинге папки.
// Поэтому скан дешевый (в папке автора 1755 файлов) и его можно гонять
// раз в несколько секунд, чтобы прогресс полз вживую.

import { parseStatsFileName, localDate } from './parser.js';
import { kvGet, kvSet, kvDel } from './db.js';

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

// Считает раны за указанную дату по каждому сценарию.
// Возвращает Map<scenarioName, count> по ВСЕМ сценариям в папке за этот день,
// фильтрация по плейлисте происходит уровнем выше.
export async function countRunsForDate(handle, date = localDate()) {
  const counts = new Map();
  let scanned = 0;
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file') continue;
    const name = entry.name;
    if (!name.endsWith('.csv')) continue;
    scanned++;
    const parsed = parseStatsFileName(name);
    if (!parsed || parsed.date !== date) continue;
    counts.set(parsed.scenario, (counts.get(parsed.scenario) || 0) + 1);
  }
  return { counts, scanned };
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
