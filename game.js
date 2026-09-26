const ROUNDS = 15;

// Stage 2 mock data; replaced by data.json in stage 3.
const MOCK = [
  { company: "Meta", title: "Data Scientist", city: "Menlo Park", salary: 185000 },
  { company: "DoorDash", title: "Data Scientist", city: "San Francisco", salary: 172000 },
  { company: "Snowflake", title: "Data Engineer", city: "San Mateo", salary: 198000 },
  { company: "Databricks", title: "Machine Learning Engineer", city: "San Francisco", salary: 225000 },
  { company: "Google", title: "Data Analyst", city: "Mountain View", salary: 142000 },
  { company: "Apple", title: "Machine Learning Engineer", city: "Cupertino", salary: 210000 },
  { company: "Uber", title: "Data Scientist II", city: "San Francisco", salary: 160000 },
  { company: "Airbnb", title: "Data Scientist", city: "San Francisco", salary: 195000 },
  { company: "Stripe", title: "Data Engineer", city: "South San Francisco", salary: 205000 },
  { company: "Salesforce", title: "Data Analyst", city: "San Francisco", salary: 128000 },
];

const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + n.toLocaleString("en-US");

let data = MOCK;
let left, right, round, results, used;

function pickNext(current) {
  let pool = data.filter((d) => !used.has(d) && d.salary !== current.salary);
  if (!pool.length) {
    used.clear();
    pool = data.filter((d) => d.salary !== current.salary);
  }
  const next = pool[Math.floor(Math.random() * pool.length)];
  used.add(next);
  return next;
}

function renderCard(el, d, showSalary) {
  el.innerHTML = `<h3>${d.company}</h3><p>${d.title}</p><p>${d.city}</p>
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
  left = pickNext({ salary: -1 });
  right = pickNext(left);
  $("game").hidden = false;
  $("end").hidden = true;
  render();
}

$("higher").onclick = () => guess(true);
$("lower").onclick = () => guess(false);
$("next").onclick = next;
$("again").onclick = start;
start();
