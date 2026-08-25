// Личная статистика: бейзлайны по сценарию, дельты сегодняшнего дня,
// диагноз-коды по нишам (clicking / tracking / switching).
//
// Главный принцип (выстрадан в AimSama и закреплен фидбеком Rauder):
// НИ ОДНОЙ абсолютной оценки. Каждая метрика сравнивается только с
// собственным бейзлайном игрока на том же сценарии. Разброс TTK сам по
// себе не значит ничего (геометрия спавнов!), "чоки" считаются как хвост
// против своей же нормы этого сценария.

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const pickNum = (runs, f) => runs.map(f).filter((v) => v != null && !Number.isNaN(v));

const MIN_BASELINE_RUNS = 4;

// Бейзлайн сценария: медианы по истории (без сегодняшнего дня)
export function scenarioBaseline(historyRuns) {
  if (historyRuns.length < MIN_BASELINE_RUNS) return null;
  return {
    runs: historyRuns.length,
    score: median(pickNum(historyRuns, (r) => r.score)),
    accuracy: median(pickNum(historyRuns, (r) => r.accuracy)),
    ttkMed: median(pickNum(historyRuns, (r) => r.ttkMed)),
    ttkTail: median(pickNum(historyRuns, (r) => r.ttkTail)),
    accDrop: median(pickNum(historyRuns, (r) => r.accDrop)),
  };
}

// Тип сценария: по данным его ранов, имя только для известных семейств.
// Покеболы это про плавный путь к цели (4BK: smooth pathing), читаем их
// как трекинг, что бы ни говорили короткие TTK.
function scenarioNiche(name, runs) {
  if (/pokeball/i.test(name)) return 'tracking';
  const counts = {};
  for (const r of runs) counts[r.type] = (counts[r.type] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[0] !== 'unknown' ? top[0] : null;
}

// Отчет дня: по каждому сценарию, сыгранному в выбранную дату, дельты
// против бейзлайна (только раны ДО этой даты); агрегация в ниши; коды.
// Работает для любого прошедшего дня, не только сегодняшнего.
export function buildDailyReport(allRuns, today) {
  const byScenario = new Map();
  for (const r of allRuns) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(r);
  }
  const playedNames = new Set(allRuns.filter((r) => r.date === today).map((r) => r.scenario));

  // ржавчина: дней с прошлой сессии до сегодняшней
  const dates = [...new Set(allRuns.map((r) => r.date))].sort();
  const prevDate = dates.filter((d) => d < today).pop() || null;
  const gapDays = prevDate ? Math.round((new Date(today) - new Date(prevDate)) / 86400000) : null;

  const scenarios = [];
  for (const name of playedNames) {
    const runs = (byScenario.get(name) || []).sort((a, b) => a.dateTime.localeCompare(b.dateTime));
    const todayRuns = runs.filter((r) => r.date === today);
    const history = runs.filter((r) => r.date < today);
    if (!todayRuns.length) continue;
    const base = scenarioBaseline(history);
    const niche = scenarioNiche(name, runs);
    const bestToday = Math.max(...pickNum(todayRuns, (r) => r.score));
    const accToday = median(pickNum(todayRuns, (r) => r.accuracy));
    const ttkToday = median(pickNum(todayRuns, (r) => r.ttkMed));
    const tailToday = median(pickNum(todayRuns, (r) => r.ttkTail));
    const dropToday = median(pickNum(todayRuns, (r) => r.accDrop));
    // рекорд "на тот момент": будущее относительно выбранного дня не подглядываем
    const allTimeBest = Math.max(...pickNum(runs.filter((r) => r.date <= today), (r) => r.score));
    scenarios.push({
      name,
      niche,
      runsToday: todayRuns.length,
      bestToday: Number.isFinite(bestToday) ? bestToday : null,
      accToday,
      base,
      isPB: Number.isFinite(bestToday) && bestToday >= allTimeBest && history.length > 0,
      scoreDelta: base && base.score ? (bestToday - base.score) / base.score : null,
      accDelta: base && base.accuracy != null && accToday != null ? accToday - base.accuracy : null,
      ttkRatio: base && base.ttkMed && ttkToday ? ttkToday / base.ttkMed : null,
      tailDelta: base && tailToday != null ? tailToday - (base.ttkTail || 0) : null,
      tailToday,
      dropToday,
    });
  }

  // ---------- коды диагнозов по нишам ----------
  const niches = {};
  for (const s of scenarios) {
    if (!s.niche || s.niche === 'unknown') continue;
    if (!niches[s.niche]) niches[s.niche] = { niche: s.niche, scenarios: [], codes: new Set() };
    niches[s.niche].scenarios.push(s);
  }

  for (const n of Object.values(niches)) {
    const withBase = n.scenarios.filter((s) => s.base);
    const scoreDeltas = pickNum(withBase, (s) => s.scoreDelta);
    const accDeltas = pickNum(withBase, (s) => s.accDelta);
    n.scoreDelta = median(scoreDeltas);
    n.accDelta = median(accDeltas);
    n.worst = [...withBase].sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0))[0] || null;
    n.best = [...withBase].sort((a, b) => (b.scoreDelta ?? 0) - (a.scoreDelta ?? 0))[0] || null;

    if (n.niche === 'clicking') {
      // стреляет быстрее обычного и попадает хуже = клики на авось
      if (n.accDelta != null && n.accDelta <= -0.05 && withBase.some((s) => s.ttkRatio != null && s.ttkRatio <= 1.05)) n.codes.add('SPAM');
      // медленнее обычного при своей же точности = пересиживание
      if (withBase.some((s) => s.ttkRatio != null && s.ttkRatio >= 1.15 && (s.accDelta ?? 0) >= -0.01)) n.codes.add('HESITATE');
    }
    // чоки: хвост длинных киллов заметно выше своей нормы
    if (withBase.some((s) => s.tailToday != null && s.tailToday > Math.max(0.08, ((s.base && s.base.ttkTail) || 0) * 1.5))) n.codes.add('CHOKES');
    // к концу ранов точность стабильно проседает = зажим
    const drops = pickNum(n.scenarios, (s) => s.dropToday);
    if (drops.length >= 2 && median(drops) <= -0.06) n.codes.add('FATIGUE');
    if (n.scoreDelta != null && n.scoreDelta <= -0.03) n.codes.add('SOFT');
    if (n.scoreDelta != null && n.scoreDelta >= 0.03) n.codes.add('STRONG');
    if (!n.codes.size) n.codes.add('OK');
    n.codes = [...n.codes].sort();

    // аспекты ниши против своей нормы: даже в зеленый день у тренера
    // должен быть материал для следующего задания
    n.aspects = {
      accDeltaPp: n.accDelta != null ? Math.round(n.accDelta * 100) : null,
      paceRatio: (() => { const v = pickNum(withBase, (s) => s.ttkRatio); return v.length ? Math.round(median(v) * 100) / 100 : null; })(),
      chokeExcessPp: (() => {
        const v = withBase.map((s) => (s.tailToday != null ? s.tailToday - ((s.base && s.base.ttkTail) || 0) : null)).filter((x) => x != null);
        return v.length ? Math.round(Math.max(...v) * 100) : null;
      })(),
      fadePp: (() => { const v = pickNum(n.scenarios, (s) => s.dropToday); return v.length ? Math.round(median(v) * 100) : null; })(),
    };
    n.pbs = n.scenarios.filter((s) => s.isPB).map((s) => s.name);
  }

  // сортировка ниш: самая проблемная первой
  const order = Object.values(niches).sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0));

  const report = {
    today,
    gapDays,
    rusty: gapDays != null && gapDays >= 3,
    scenarios: scenarios.sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0)),
    niches: order,
    pbs: scenarios.filter((s) => s.isPB).map((s) => s.name),
  };
  report.stateHash = hashReport(report);
  return report;
}

// Хэш состояния: коды + дельты, огрубленные до 5%. Пока хэш не меняется,
// новый текст коуча не генерируется, ответ берется из кэша.
function hashReport(report) {
  const bucket = (v) => (v == null ? 'x' : Math.round(v * 20));
  const src = report.niches.map((n) =>
    `${n.niche}:${n.codes.join('+')}:${bucket(n.scoreDelta)}:${bucket(n.accDelta)}:${n.worst ? n.worst.name : ''}:${n.aspects ? [n.aspects.paceRatio, n.aspects.chokeExcessPp, n.aspects.fadePp].join(',') : ''}`
  ).join('|') + (report.rusty ? `|rust${report.gapDays}` : '');
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + src.length;
}

// Компактный пейлоад для воркера-коуча
export function coachPayload(report) {
  const pct = (v) => (v == null ? null : Math.round(v * 100));
  return {
    stateHash: report.stateHash,
    rustyDays: report.rusty ? report.gapDays : null,
    niches: report.niches.map((n) => ({
      niche: n.niche,
      codes: n.codes,
      scoreDeltaPct: pct(n.scoreDelta),
      accDeltaPp: pct(n.accDelta),
      worstScenario: n.worst ? n.worst.name : null,
      worstScenarioDeltaPct: n.worst ? pct(n.worst.scoreDelta) : null,
      bestScenario: n.best ? n.best.name : null,
      aspects: n.aspects || null,
      pbs: n.pbs || [],
      runsToday: n.scenarios.reduce((a, s) => a + s.runsToday, 0),
    })),
  };
}
