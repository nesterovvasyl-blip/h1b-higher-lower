const ROUNDS = 15;

const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + n.toLocaleString("en-US");

const MIN_DIFF = 0.10;  // next salary differs by at least 10%...
const MAX_DIFF = 0.60;  // ...but not by more than 60% (too obvious)
const SWE_CAP = 0.30;   // at most 30% of shown cards are Software Engineer roles
const FAMOUS_WEIGHT = 3;

let data = [];
let left, right, round, results, used, shown, sweShown;

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
  shown++;
  if (isSwe(next)) sweShown++;
  return next;
}

function renderCard(el, d, showSalary) {
  el.innerHTML = `<h3>${d.company}</h3><p>${d.title}</p><p>${d.city}</p>
    <p><small>median of ${d.n} filings</small></p>
    <p class="salary">${showSalary ? fmt(d.salary) : "???"}</p>`;
}

function render() {
  $("status").textContent = `Round ${round + 1}/${ROUNDS} · Score ${results.filter(Boolean).length}`;
  renderCard($("left"), left, true);
  renderCard($("right"), right, false);
  $("right").style.background = "";
  $("higher").hidden = $("lower").hidden = false;
  $("next").hidden = true;
}

function guess(higher) {
  const ok = higher ? right.salary > left.salary : right.salary < left.salary;
  results.push(ok);
  renderCard($("right"), right, true);
  $("right").style.background = ok ? "lightgreen" : "salmon";
  $("higher").hidden = $("lower").hidden = true;
  $("next").hidden = false;
}

function next() {
  round++;
  if (round >= ROUNDS) return end();
  left = right;
  right = pickNext(left);
  render();
}

function end() {
  $("game").hidden = true;
  $("end").hidden = false;
  $("score").textContent = `Guessed ${results.filter(Boolean).length}/${ROUNDS}`;
  $("emoji").textContent = results.map((r) => (r ? "🟩" : "🟥")).join("");
}

function start() {
  round = 0;
  results = [];
  used = new Set();
  shown = 0;
  sweShown = 0;
  left = pickNext({ salary: 0 });
  right = pickNext(left);
  $("game").hidden = false;
  $("end").hidden = true;
  render();
}

$("higher").onclick = () => guess(true);
$("lower").onclick = () => guess(false);
$("next").onclick = next;
$("again").onclick = start;

fetch("data.json")
  .then((r) => r.json())
  .then((rows) => {
    data = rows;
    start();
  })
  .catch((e) => ($("status").textContent = "Failed to load data.json: " + e));
