// Кликабельный глоссарий (портирован из AimSama): аим-жаргон в строках коуча
// подсвечивается, клик показывает объяснение простым английским. Большинство
// друзей не говорят на аимерском.

const TERMS = {
  'pace': 'How fast you go from kill to kill. Adding pace = playing slightly faster; never at the cost of technique.',
  'chain': 'Going from one kill straight into the next without a pause in between.',
  'chains': 'Going from one kill straight into the next without a pause in between.',
  'chaining': 'Going from one kill straight into the next without a pause in between.',
  'dead center': 'The exact middle of the target. Clicking the middle (not the edges) forces your crosshair and the target to truly line up.',
  'confirmation': 'Visually checking the crosshair is ON the target before clicking, instead of clicking and hoping.',
  'confirm': 'Visually check the crosshair is ON the target before clicking, instead of clicking and hoping.',
  'overflick': 'Flicking past the target instead of landing on it.',
  'overflicking': 'Flicking past the target instead of landing on it.',
  'underflick': 'Flicking slightly short of the target. Preferred over flying past it: a small forward correction is cheap.',
  'flick': 'A fast snap of the crosshair to a target.',
  'initial flick': 'The first, fast part of the movement toward the target.',
  'micro': 'The small correction right before the click. Should blend into the flick, not be a separate motion.',
  'micro adjustment': 'The small correction right before the click. Should blend into the flick, not be a separate motion.',
  'smooth pathing': 'A pokeball technique: move in one straight line from ball to ball at any speed, with zero over- or underflick.',
  'lines': 'The path your crosshair draws between targets. Clean lines = straight, no flying past, no wobble.',
  'strafe': 'A target (or player) moving side to side.',
  'strafes': 'Targets (or players) moving side to side.',
  'reactive': 'Reacting to a sharp, unexpected change of direction. Everything before and after the change is smoothness.',
  'smoothness': 'Slow, steady tracking without shaking. The foundation of all tracking.',
  'precision': 'Staying glued to one small spot of the target while it moves, without drifting inside it.',
  'glue': 'Keeping the crosshair fixed to one body part of the target, as if attached.',
  'glued': 'Crosshair fixed to one body part of the target, as if attached.',
  'speed matching': 'Moving your crosshair at the same speed the target moves. Lagging behind it = undertracking.',
  'undertracking': 'Constantly aiming BEHIND a moving target: chasing where it was instead of sitting on it.',
  'tracking': 'Keeping the crosshair on a moving target.',
  'handspeed': 'How fast your hand physically moves. Raised gradually, about +5% at a time, never all at once.',
  'dynamic': 'Moving targets you click once: track briefly, then shoot. Never spam these.',
  'static': 'Standing targets you click. Trains knowing WHEN to click, not just speed.',
  'target switching': 'Scenarios where you hold the mouse button and jump between targets. Trains flick speed.',
  'pokeball': 'Scenarios where you hold the mouse button and drag between static balls. Trains clean lines. Low accuracy there is normal.',
  'punishment': 'Scenarios that punish a miss instantly (target disappears or resets), like a death in a real game.',
  'regen': 'Targets regain health when you miss or leave them. Punishes shaky aim, rewards staying glued.',
  'warmup': 'The first runs of a session while hands are cold. Weak early numbers are normal.',
  'your usual': 'Your own median result from past runs of the same scenario. You are compared only to yourself, never to others.',
  'intercept': 'Aiming where the target WILL be, not where it was a moment ago.',
  'spam': 'Clicking fast without confirming the crosshair is on the target. High pace, low accuracy.',
  'timescale': 'Playing a slowed-down version of a scenario (for example 75% speed) to clean up technique before normal speed.',
  'eyes first': 'Snap your EYES to the next target before the hand moves; the hand follows the eyes.',
};

// длинные ключи первыми, чтобы "smooth pathing" выигрывал у "smooth"
const NAMES = Object.keys(TERMS).sort((a, b) => b.length - a.length);
const PATTERN = new RegExp('\\b(' + NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'gi');

// Оборачивает известные термины в кликабельные спаны. Идемпотентно.
export function annotateTerms(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.length < 3) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || p.closest('.term, script, style, button')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const node of targets) {
    const text = node.nodeValue;
    PATTERN.lastIndex = 0;
    if (!PATTERN.test(text)) continue;
    PATTERN.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = PATTERN.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'term';
      span.textContent = m[0];
      span.dataset.def = TERMS[m[0].toLowerCase()] || '';
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// Один общий поповер на все термины.
export function initGlossary() {
  const pop = document.createElement('div');
  pop.id = 'term-pop';
  pop.hidden = true;
  document.body.appendChild(pop);

  document.addEventListener('click', (ev) => {
    const term = ev.target.closest('.term');
    if (!term) {
      pop.hidden = true;
      return;
    }
    ev.preventDefault();
    const def = term.dataset.def;
    if (!def) return;
    pop.replaceChildren();
    const b = document.createElement('b');
    b.textContent = term.textContent;
    const d = document.createElement('div');
    d.textContent = def;
    pop.append(b, d);
    pop.hidden = false;
    const r = term.getBoundingClientRect();
    const popW = Math.min(320, window.innerWidth - 24);
    pop.style.maxWidth = popW + 'px';
    let left = r.left + r.width / 2 - popW / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - popW - 12));
    pop.style.left = left + 'px';
    pop.style.top = window.scrollY + r.top - 8 + 'px';
    pop.style.transform = 'translateY(-100%)';
  });
  window.addEventListener('scroll', () => { pop.hidden = true; }, { passive: true });
}
