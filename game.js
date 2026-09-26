const MODES = {
  classic: {
    rounds: 10, countMs: 1100, holdMs: 1100,
    hint: "Does the right job pay <b>higher</b> or <b>lower</b>? Keys: ↑ / ↓",
  },
  timed: {
    rounds: Infinity, countMs: 350, holdMs: 350,
    clock: 60, bonus: 3, penalty: 5,  // seconds
    hint: "<b>+3s</b> right, <b>−5s</b> wrong. The clock pauses while answers are revealed. Keys: ↑ / ↓",
  },
};

const MIN_DIFF = 0.10;  // next salary differs by at least 10%...
const MAX_DIFF = 0.60;  // ...but not by more than 60% (too obvious)
const SWE_CAP = 0.30;   // at most 30% of shown cards are Software Engineer roles
const FAMOUS_WEIGHT = 3;

const SLIDE_MS = 450;   // keep in sync with --slide in style.css
const MAP_W = 170;      // map viewport width in SVG units (~2.1° lon, ~190 km)
const MAP_H = MAP_W * 9 / 16;

const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let data = [];
let map = null;
let left, right, round, results, used, shown, sweShown, busy, seen;
let modeKey = "classic", mode = MODES.classic;
let gen = 0;  // bumped on every start(); async steps from an older game bail out
let clockMs, playedMs, lastTick;

// ---------- pair selection ----------

const isSwe = (d) => d.family === "Software Engineer";

function weightedPick(pool) {
  const total = pool.reduce((s, d) => s + (d.famous ? FAMOUS_WEIGHT : 1), 0);
  let r = Math.random() * total;
  for (const d of pool) {
    r -= d.famous ? FAMOUS_WEIGHT : 1;
    if (r <= 0) return d;
  }
  return pool[pool.length - 1];
}

function pickNext(current) {
  const sweOk = sweShown + 1 <= SWE_CAP * (shown + 1);
  const diff = (d) => Math.abs(d.salary - current.salary) / Math.min(d.salary, current.salary);
  // Strictest filters first; relax until something matches.
  const filters = [
    (d) => (sweOk || !isSwe(d)) && d.company !== current.company && diff(d) >= MIN_DIFF && diff(d) <= MAX_DIFF,
    (d) => (sweOk || !isSwe(d)) && diff(d) >= MIN_DIFF && diff(d) <= MAX_DIFF,
    (d) => diff(d) >= MIN_DIFF,
    (d) => d.salary !== current.salary,
  ];
  let fresh = data.filter((d) => !used.has(d.id));
  if (fresh.length < 20) {
    // Long timed runs can exhaust the pool: recycle everything but the cards on screen.
    used = new Set(seen.slice(-2).map((d) => d.id));
    fresh = data.filter((d) => !used.has(d.id));
  }
  let pool = [];
  for (const f of filters) {
    pool = (current.salary ? fresh.filter(f) : fresh.filter((d) => sweOk || !isSwe(d)));
    if (pool.length) break;
  }
  const next = weightedPick(pool);
  used.add(next.id);
  seen.push(next);
  shown++;
  if (isSwe(next)) sweShown++;
  return next;
}

// ---------- rendering ----------

function logoHtml(d) {
  const initials = d.company.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const hue = [...d.company].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const fallback = `<div class="logo" style="background:hsl(${hue} 45% 38%)">${initials}</div>`;
  if (!d.domain) return fallback;
  const src = `https://www.google.com/s2/favicons?domain=${d.domain}&sz=128`;
  // Google serves a 16px globe instead of an error for unknown domains, so treat tiny images as missing.
  const swap = `this.parentElement.outerHTML='${fallback.replace(/"/g, "&quot;")}'`;
  return `<div class="logo"><img src="${src}" alt="${d.company} logo"
    onload="if (this.naturalWidth < 32) ${swap}" onerror="${swap}"></div>`;
}

function mapHtml(city) {
  const pt = map && map.cities[city];
  if (!pt) return "";
  const [cx, cy] = pt;
  const u = MAP_W / 100;  // marker/label size unit
  const vb = [cx - MAP_W / 2, cy - MAP_H / 2, MAP_W, MAP_H].map((v) => v.toFixed(1)).join(" ");
  const refs = map.landmarks
    .filter((l) => l !== city)
    .map((l) => [l, map.cities[l]])
    .filter(([, [x, y]]) => Math.abs(x - cx) < MAP_W / 2 - 12 * u && Math.abs(y - cy) < MAP_H / 2 - 4 * u &&
                           Math.hypot(x - cx, y - cy) > 10 * u)
    .map(([l, [x, y]]) => `<circle class="ref-dot" cx="${x}" cy="${y}" r="${0.9 * u}"/>
      <text class="ref" x="${x + 2 * u}" y="${y + 1.2 * u}" font-size="${3.6 * u}">${l}</text>`)
    .join("");
  const [bx, by, bw, bh] = map.bbox;
  return `<div class="map" aria-label="Map: ${city}, California">
    <svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice">
      <use href="#ca-land" class="land"/>
      ${refs}
      <circle class="pulse" cx="${cx}" cy="${cy}" r="${2.4 * u}"/>
      <circle class="pin" cx="${cx}" cy="${cy}" r="${1.6 * u}"/>
      <text class="pin-label" x="${cx + 3 * u}" y="${cy + 1.5 * u}" font-size="${4.4 * u}"
        stroke-width="${1 * u}">${city}</text>
    </svg>
    <svg class="inset" viewBox="${bx} ${by} ${bw} ${bh}">
      <use href="#ca-land" class="land"/>
      <circle class="pin" cx="${cx}" cy="${cy}" r="${bw / 18}"/>
    </svg>
  </div>`;
}

function renderCard(el, d, hidden) {
  el.className = "card";
  el.innerHTML = `
    ${logoHtml(d)}
    <div class="head">
      <div class="company">${d.company}</div>
      <div class="title">${d.title}</div>
      <div class="city">${d.city}, ${d.state}</div>
    </div>
    ${mapHtml(d.city)}
    <div class="salary">${hidden ? "$???" : fmt(d.salary)}</div>
    <div class="n">median of ${d.n} filings</div>
    ${hidden ? `<div class="actions">
      <button class="btn higher" data-guess="higher">▲ Higher</button>
      <button class="btn lower" data-guess="lower">▼ Lower</button>
    </div>` : ""}`;
}

const correct = () => results.filter(Boolean).length;
const accuracy = () => (results.length ? Math.round((100 * correct()) / results.length) : 0);

function renderStatus() {
  $("progress").hidden = !!mode.clock;
  $("timer").hidden = !mode.clock;
  if (mode.clock) return renderClock();
  $("status").textContent = `Round ${Math.min(round + 1, mode.rounds)} of ${mode.rounds} · Score ${correct()}`;
  $("progress").innerHTML = Array.from({ length: mode.rounds }, (_, i) =>
    `<li class="${i < results.length ? (results[i] ? "ok" : "bad") : i === round ? "now" : ""}"></li>`
  ).join("");
}

function renderClock() {
  $("status").textContent = `⏱ ${(clockMs / 1000).toFixed(1)}s · ${correct()} correct` +
    (results.length ? ` · ${accuracy()}%` : "");
  $("timer-fill").style.width = Math.min(100, clockMs / (mode.clock * 10)) + "%";
  $("timer").classList.toggle("low", clockMs < 10000);
}

function showDelta(sec) {
  const chip = document.createElement("span");
  chip.className = "delta " + (sec > 0 ? "up" : "down");
  chip.textContent = (sec > 0 ? "+" : "−") + Math.abs(sec) + "s";
  $("timer").append(chip);
  setTimeout(() => chip.remove(), 1000);
}

// Counts down only while the player is thinking: paused during reveals (busy)
// and while the tab is hidden (rAF stops; dt is clamped on return).
function tick(t, g) {
  if (g !== gen || $("game").hidden) return;
  const dt = Math.max(0, Math.min(t - lastTick, 100));
  lastTick = t;
  if (!busy) {
    clockMs = Math.max(0, clockMs - dt);
    playedMs += dt;
    if (clockMs === 0) {
      busy = true;
      return end();
    }
  }
  renderClock();
  requestAnimationFrame((t) => tick(t, g));
}

function render() {
  renderStatus();
  renderCard($("left"), left, false);
  renderCard($("right"), right, true);
}

// ---------- animation ----------

function countUp(el, target, ms) {
  if (reducedMotion) {
    el.textContent = fmt(target);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.textContent = fmt(target);
      resolve();
    };
    const step = (t) => {
      if (done) return;
      const p = Math.min(1, (t - t0) / ms);
      el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));  // ease-out cubic
      p < 1 ? requestAnimationFrame(step) : finish();
    };
    requestAnimationFrame(step);
    setTimeout(finish, ms + 150);  // rAF pauses in background tabs; never stall the game
  });
}

async function slide(g) {
  const L = $("left"), R = $("right");
  const a = L.getBoundingClientRect(), b = R.getBoundingClientRect();
  L.classList.add("exit");
  R.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
  await sleep(SLIDE_MS);
  if (g !== gen) return;

  // Swap content with transitions off, then slide the new right card in.
  const board = $("board");
  board.classList.add("no-anim");
  left = right;
  right = pickNext(left);
  R.style.transform = "";
  render();
  R.classList.add("enter");
  void R.offsetWidth;
  board.classList.remove("no-anim");
  R.classList.remove("enter");
}

// ---------- game flow ----------

async function guess(higher) {
  if (busy) return;
  busy = true;
  const g = gen;
  const R = $("right");
  R.querySelectorAll(".btn").forEach((b) => (b.disabled = true));

  const ok = higher ? right.salary > left.salary : right.salary < left.salary;
  await countUp(R.querySelector(".salary"), right.salary, mode.countMs);
  if (g !== gen) return;
  results.push(ok);
  R.classList.add(ok ? "correct" : "wrong");
  if (mode.clock) {
    const sec = ok ? mode.bonus : -mode.penalty;
    clockMs = Math.max(0, clockMs + sec * 1000);
    showDelta(sec);
  }
  renderStatus();
  await sleep(reducedMotion ? Math.min(600, mode.holdMs) : mode.holdMs);
  if (g !== gen) return;

  round++;
  if (round >= mode.rounds || (mode.clock && clockMs <= 0)) return end();
  await slide(g);
  if (g !== gen) return;
  busy = false;
}

// ---------- end screen ----------

const RANK = { Junior: 0, Mid: 1, Senior: 2, Staff: 3, Manager: 3, Principal: 4 };
const k = (n) => "$" + Math.round(n / 1000) + "k";
const withArticle = (t) => (/^([AEIOU]|ML\b)/.test(t) ? "an " : "a ") + t;
const role = (d) => (d.seniority === "Mid" ? "mid-level " + d.title : d.title);

// One surprising line from the cards seen this game, strongest pattern first.
function insight(cards) {
  const pairs = [];
  for (const a of cards) for (const b of cards) if (a.company !== b.company && a.salary > b.salary) pairs.push([a, b]);
  const gap = ([a, b]) => a.salary - b.salary;
  const best = (ps) => ps.sort((x, y) => gap(y) - gap(x))[0];

  // 1. Same job family, lower seniority out-earns higher seniority.
  const inversion = best(pairs.filter(([a, b]) => a.family === b.family && RANK[a.seniority] < RANK[b.seniority]));
  if (inversion) {
    const [a, b] = inversion;
    return `${a.company} pays ${withArticle(role(a))} ${k(gap(inversion))} more than ${b.company} pays ${withArticle(b.title)}.`;
  }
  // 2. Same job title, different companies.
  const same = best(pairs.filter(([a, b]) => a.title === b.title));
  if (same) {
    const [a, b] = same;
    return `Same job, different check: ${withArticle(a.title)} at ${a.company} makes ${k(gap(same))} more than at ${b.company}.`;
  }
  // 3. Widest spread of the game.
  const [a, b] = best(pairs);
  return `Widest gap this game: ${withArticle(a.title)} at ${a.company} (${k(a.salary)}) vs ${withArticle(b.title)} at ${b.company} (${k(b.salary)}).`;
}

const GRID_MAX = 50;  // squares shown on a timed run's end screen

function verdict(score) {
  const [a, b, c] = mode.clock ? [30, 20, 12] : [9, 7, 5];
  return score >= a ? "Comp-band oracle. Are you in HR?" :
    score >= b ? "Solid market sense." :
    score >= c ? "Coin flip with extra steps." : "Maybe don't negotiate your own offer.";
}

// Returns the previous best for this mode (0 if none) and stores the new one.
function saveBest(score) {
  const key = "h1b-best-" + modeKey;
  let best = 0;
  try {
    best = Number(localStorage.getItem(key)) || 0;
    if (score > best) localStorage.setItem(key, score);
  } catch {}
  return best;
}

function end() {
  $("game").hidden = true;
  $("end").hidden = false;
  renderStatus();
  $("status").textContent = "Game over";
  const score = correct();
  $("score").textContent = mode.clock
    ? `${score} correct in ${Math.round(playedMs / 1000)}s`
    : `Guessed ${score}/${mode.rounds}`;
  $("verdict").textContent = verdict(score) + (mode.clock && results.length ? ` · ${accuracy()}% accuracy` : "");
  const best = saveBest(score);
  $("best").textContent =
    best && score > best ? `🏆 New personal best! (was ${best})` :
    best ? `Personal best: ${best}` : "";
  const per = mode.clock ? 10 : 5;
  const grid = results.slice(0, GRID_MAX);
  const rows = [];
  for (let i = 0; i < grid.length; i += per) rows.push(grid.slice(i, i + per).map((r) => (r ? "🟩" : "🟥")).join(""));
  if (results.length > GRID_MAX) rows[rows.length - 1] += "…";
  $("emoji").innerHTML = rows.join("<br>");
  // Only cards the player actually judged (a timed run can end with one unrevealed).
  const cards = seen.slice(0, results.length + 1);
  $("insight").parentElement.hidden = !results.length;
  if (results.length) $("insight").textContent = insight(cards);
  $("recap-title").textContent = `Your ${cards.length} card${cards.length === 1 ? "" : "s"}, by pay`;
  $("recap").innerHTML = [...cards].sort((a, b) => b.salary - a.salary).map((d) =>
    `<li><span><b>${d.company}</b> · ${d.title} · ${d.city}</span><span>${fmt(d.salary)}</span></li>`
  ).join("");
  busy = false;
}

function start(key = modeKey) {
  modeKey = MODES[key] ? key : "classic";
  mode = MODES[modeKey];
  gen++;
  document.querySelectorAll("#modes button").forEach((b) =>
    b.setAttribute("aria-pressed", b.dataset.mode === modeKey));
  $("hint").innerHTML = mode.hint;
  $("right").style.transform = "";  // in case a slide was interrupted
  $("timer").querySelectorAll(".delta").forEach((c) => c.remove());
  clockMs = (mode.clock || 0) * 1000;
  playedMs = 0;
  round = 0;
  results = [];
  used = new Set();
  shown = 0;
  sweShown = 0;
  busy = false;
  seen = [];
  left = pickNext({ salary: 0 });
  right = pickNext(left);
  $("game").hidden = false;
  $("end").hidden = true;
  render();
  if (mode.clock) {
    const g = gen;
    lastTick = performance.now();
    requestAnimationFrame((t) => tick(t, g));
  }
}

const hashMode = () => location.hash.slice(1);

$("modes").addEventListener("click", (e) => {
  const key = e.target.closest("[data-mode]")?.dataset.mode;
  if (!key) return;
  history.replaceState(null, "", key === "classic" ? location.pathname + location.search : "#" + key);
  start(key);
  e.target.blur();  // so Enter/Space don't re-trigger a restart mid-game
});
addEventListener("hashchange", () => data.length && start(hashMode()));

$("right").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-guess]");
  if (btn) guess(btn.dataset.guess === "higher");
});
document.addEventListener("keydown", (e) => {
  if ($("game").hidden) return;
  if (e.key === "ArrowUp") guess(true);
  if (e.key === "ArrowDown") guess(false);
});
$("again").onclick = () => start();

Promise.all([
  fetch("data.json").then((r) => r.json()),
  fetch("map.json").then((r) => r.json()).catch(() => null),  // map is optional
])
  .then(([rows, m]) => {
    data = rows;
    map = m;
    if (map) document.getElementById("ca-land").setAttribute("d", map.path);
    start(hashMode());
  })
  .catch((e) => ($("status").textContent = "Failed to load data.json: " + e));
