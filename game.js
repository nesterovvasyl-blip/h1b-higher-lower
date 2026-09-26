const ROUNDS = 15;

const MIN_DIFF = 0.10;  // next salary differs by at least 10%...
const MAX_DIFF = 0.60;  // ...but not by more than 60% (too obvious)
const SWE_CAP = 0.30;   // at most 30% of shown cards are Software Engineer roles
const FAMOUS_WEIGHT = 3;

const COUNT_MS = 1100;  // salary count-up
const HOLD_MS = 1100;   // pause on green/red before sliding
const SLIDE_MS = 450;   // keep in sync with --slide in style.css
const MAP_W = 170;      // map viewport width in SVG units (~2.1° lon, ~190 km)
const MAP_H = MAP_W * 9 / 16;

const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let data = [];
let map = null;
const SITE_URL = "https://nesterovvasyl-blip.github.io/h1b-higher-lower/";

let left, right, round, results, used, shown, sweShown, busy, seen;

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
  const fresh = data.filter((d) => !used.has(d.id));
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

function renderStatus() {
  const score = results.filter(Boolean).length;
  $("status").textContent = `Round ${Math.min(round + 1, ROUNDS)} of ${ROUNDS} · Score ${score}`;
  $("progress").innerHTML = Array.from({ length: ROUNDS }, (_, i) =>
    `<li class="${i < results.length ? (results[i] ? "ok" : "bad") : i === round ? "now" : ""}"></li>`
  ).join("");
}

function render() {
  renderStatus();
  renderCard($("left"), left, false);
  renderCard($("right"), right, true);
}

// ---------- animation ----------

function countUp(el, target) {
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
      const p = Math.min(1, (t - t0) / COUNT_MS);
      el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));  // ease-out cubic
      p < 1 ? requestAnimationFrame(step) : finish();
    };
    requestAnimationFrame(step);
    setTimeout(finish, COUNT_MS + 150);  // rAF pauses in background tabs; never stall the game
  });
}

async function slide() {
  const L = $("left"), R = $("right");
  const a = L.getBoundingClientRect(), b = R.getBoundingClientRect();
  L.classList.add("exit");
  R.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
  await sleep(SLIDE_MS);

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
  const R = $("right");
  R.querySelectorAll(".btn").forEach((b) => (b.disabled = true));

  const ok = higher ? right.salary > left.salary : right.salary < left.salary;
  await countUp(R.querySelector(".salary"), right.salary);
  results.push(ok);
  R.classList.add(ok ? "correct" : "wrong");
  renderStatus();
  await sleep(reducedMotion ? 600 : HOLD_MS);

  round++;
  if (round >= ROUNDS) return end();
  await slide();
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

function shareText() {
  const rows = [];
  for (let i = 0; i < results.length; i += 5) rows.push(results.slice(i, i + 5).map((r) => (r ? "🟩" : "🟥")).join(""));
  return `H-1B Higher or Lower ${results.filter(Boolean).length}/${ROUNDS}\n${rows.join("\n")}\n${SITE_URL}`;
}

function legacyCopy(text) {
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

async function copyResult() {
  const text = shareText();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text);
  }
  if (!ok) {
    // Last resort: show the text pre-selected so the player can copy it by hand.
    const box = $("share-text");
    box.value = text;
    box.hidden = false;
    box.select();
    return;
  }
  $("copy").textContent = "Copied ✓";
  setTimeout(() => ($("copy").textContent = "Copy result"), 1800);
}

function end() {
  $("game").hidden = true;
  $("end").hidden = false;
  renderStatus();
  $("status").textContent = "Game over";
  const score = results.filter(Boolean).length;
  $("score").textContent = `Guessed ${score}/${ROUNDS}`;
  $("verdict").textContent =
    score >= 13 ? "Comp-band oracle. Are you in HR?" :
    score >= 10 ? "Solid market sense." :
    score >= 7 ? "Coin flip with extra steps." : "Maybe don't negotiate your own offer.";
  $("emoji").innerHTML = shareText().split("\n").slice(1, -1).join("<br>");
  $("insight").textContent = insight(seen);
  $("share").hidden = !navigator.share;
  $("share-text").hidden = true;
  $("recap").innerHTML = [...seen].sort((a, b) => b.salary - a.salary).map((d) =>
    `<li><span><b>${d.company}</b> · ${d.title} · ${d.city}</span><span>${fmt(d.salary)}</span></li>`
  ).join("");
  busy = false;
}

function start() {
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
}

$("right").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-guess]");
  if (btn) guess(btn.dataset.guess === "higher");
});
document.addEventListener("keydown", (e) => {
  if ($("game").hidden) return;
  if (e.key === "ArrowUp") guess(true);
  if (e.key === "ArrowDown") guess(false);
});
$("again").onclick = start;
$("copy").onclick = copyResult;
$("share").onclick = () => navigator.share({ text: shareText() }).catch(() => {});

Promise.all([
  fetch("data.json").then((r) => r.json()),
  fetch("map.json").then((r) => r.json()).catch(() => null),  // map is optional
])
  .then(([rows, m]) => {
    data = rows;
    map = m;
    if (map) document.getElementById("ca-land").setAttribute("d", map.path);
    start();
  })
  .catch((e) => ($("status").textContent = "Failed to load data.json: " + e));
