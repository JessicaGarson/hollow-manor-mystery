const $ = (sel) => document.querySelector(sel);

const state = {
  suspects: [],
  images: {},          // id -> url
  histories: {},       // suspect id -> [{role, content}]
  current: null,
  accused: null,
  log: [],
};

const QUICK_QUESTIONS = [
  "Where were you between 11:30 and midnight?",
  "What was your relationship with Lord Silas?",
  "Did you see anyone near the library?",
  "Who do you think did it?",
  "What costume was everyone wearing?",
];

// ---- helpers -----------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function prose(s) {
  return escapeHtml(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function fmtMs(ms) {
  if (ms == null) return "–";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function statLine(stats) {
  if (!stats) return "cached";
  const cost = stats.cost != null ? ` · $${stats.cost.toFixed(4)}` : "";
  return `⚡ ${stats.endpoint} · queue ${fmtMs(stats.delayMs)} · run ${fmtMs(stats.executionMs)}${cost}`;
}

function flashLightning() {
  const el = $("#lightning");
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ---- inference log -----------------------------------------------------------

function record(what, stats) {
  if (!stats) return;
  state.log.push({ what, ...stats });
  $("#log-count").textContent = state.log.length;
  const li = document.createElement("li");
  li.innerHTML = `
    <div><span class="ep">${escapeHtml(stats.endpoint)}</span></div>
    <div class="what">${escapeHtml(what)}</div>
    <div class="nums">queue ${fmtMs(stats.delayMs)} · exec ${fmtMs(stats.executionMs)} · round-trip ${fmtMs(stats.roundTripMs)}${
      stats.cost != null ? ` · $${stats.cost.toFixed(4)}` : ""
    }</div>
    <div class="nums">worker ${escapeHtml(stats.workerId || "–")}</div>`;
  $("#log-list").appendChild(li);

  const total = state.log.reduce((a, s) => a + (s.cost || 0), 0);
  const llm = state.log.filter((s) => s.endpoint === window.MODELS.llm);
  const avg = llm.length ? llm.reduce((a, s) => a + (s.executionMs || 0), 0) / llm.length : null;
  $("#log-totals").innerHTML = `
    <div><b>${state.log.length}</b><span>jobs run</span></div>
    <div><b>$${total.toFixed(4)}</b><span>total spend</span></div>
    <div><b>${avg != null ? fmtMs(Math.round(avg)) : "–"}</b><span>avg LLM exec</span></div>
    <div><b>${new Set(state.log.map((s) => s.workerId)).size}</b><span>GPU workers seen</span></div>`;
}

// ---- images ------------------------------------------------------------------

function setImage(id, url) {
  state.images[id] = url;
  document.querySelectorAll(`img[data-img="${id}"]`).forEach((img) => {
    img.onload = () => img.classList.add("loaded");
    img.src = url;
  });
}

async function paint(id, label) {
  try {
    const { url, stats } = await api("/api/image", { id });
    setImage(id, url);
    record(`Painted ${label}`, stats);
  } catch (e) {
    document.querySelectorAll(`img[data-img="${id}"] + .img-loading`).forEach((el) => {
      el.textContent = "the spirits refused (image failed)";
      el.style.animation = "none";
    });
    console.error(e);
  }
}

// ---- suspects & interrogation -----------------------------------------------

function renderSuspects() {
  $("#suspects").innerHTML = state.suspects
    .map(
      (s) => `
    <div class="suspect" data-id="${s.id}">
      <div class="portrait"><img data-img="${s.id}" alt="${escapeHtml(s.name)}"><div class="img-loading">painting portrait…</div></div>
      <h4>${escapeHtml(s.name)}</h4>
      <div class="title">${escapeHtml(s.title)}</div>
      <div class="qcount" id="qc-${s.id}">not yet questioned</div>
    </div>`
    )
    .join("");
  document.querySelectorAll(".suspect").forEach((el) => el.addEventListener("click", () => openSuspect(el.dataset.id)));
}

function openSuspect(id) {
  const s = state.suspects.find((x) => x.id === id);
  state.current = id;
  state.histories[id] = state.histories[id] || [];
  document.querySelectorAll(".suspect").forEach((el) => el.classList.toggle("active", el.dataset.id === id));
  $("#pick-hint").classList.add("hidden");
  $("#interrogation").classList.remove("hidden");

  const portrait = $("#int-portrait");
  portrait.dataset.img = id;
  portrait.src = state.images[id] || "";
  $("#int-name").textContent = s.name;
  $("#int-meta").textContent = `${s.title} · wearing ${s.costume}. ${s.public}`;

  const chat = $("#chat");
  chat.innerHTML = "";
  if (!state.histories[id].length) {
    addMsg("assistant", `*${s.name} regards you warily from behind ${s.costume.split(",")[0]}.*`);
  }
  state.histories[id].forEach((m) => addMsg(m.role, m.content, m.stats));

  $("#chips").innerHTML = QUICK_QUESTIONS.map((q) => `<button class="chip" type="button">${escapeHtml(q)}</button>`).join("");
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => ask(c.textContent)));
  $("#question").focus();
  $("#interrogation").scrollIntoView({ behavior: "smooth", block: "start" });
}

function addMsg(role, text, stats, cls = "") {
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}`;
  div.innerHTML = prose(text) + (stats ? `<span class="meta">${escapeHtml(statLine(stats))}</span>` : "");
  $("#chat").appendChild(div);
  $("#chat").scrollTop = $("#chat").scrollHeight;
  return div;
}

async function ask(question) {
  question = question.trim();
  const id = state.current;
  if (!question || !id) return;
  const s = state.suspects.find((x) => x.id === id);
  const history = state.histories[id];

  $("#question").value = "";
  $("#ask-btn").disabled = true;
  addMsg("user", question);
  const thinking = addMsg("assistant", `${s.name.split(" ").slice(-1)[0]} considers the question…`, null, "thinking");

  try {
    const { answer, stats } = await api("/api/interrogate", {
      suspect: id,
      question,
      history: history.map(({ role, content }) => ({ role, content })),
    });
    thinking.remove();
    history.push({ role: "user", content: question }, { role: "assistant", content: answer, stats });
    addMsg("assistant", answer, stats);
    record(`Interrogated ${s.name}`, stats);
    const n = history.length / 2;
    $(`#qc-${id}`).textContent = `${n} question${n === 1 ? "" : "s"} asked`;
    if (Math.random() < 0.25) flashLightning();
  } catch (e) {
    thinking.remove();
    addMsg("assistant", `The candle gutters out… (${e.message})`, null, "error");
  } finally {
    $("#ask-btn").disabled = false;
    if (state.current === id) $("#question").focus();
  }
}

// ---- accusation ----------------------------------------------------------------

function openAccuse() {
  state.accused = null;
  $("#confirm-accuse").disabled = true;
  $("#accuse-choices").innerHTML = state.suspects
    .map((s) => `<button data-id="${s.id}"><img src="${state.images[s.id] || ""}" alt="">${escapeHtml(s.name)}</button>`)
    .join("");
  document.querySelectorAll("#accuse-choices button").forEach((b) =>
    b.addEventListener("click", () => {
      state.accused = b.dataset.id;
      document.querySelectorAll("#accuse-choices button").forEach((x) => x.classList.toggle("selected", x === b));
      $("#confirm-accuse").disabled = false;
    })
  );
  $("#accuse-modal").classList.remove("hidden");
}

async function confirmAccuse() {
  const s = state.suspects.find((x) => x.id === state.accused);
  $("#accuse-modal").classList.add("hidden");
  $("#reveal").classList.remove("hidden");
  $("#reveal .modal-card").classList.remove("win");
  $("#reveal-title").textContent = "The lights go out…";
  $("#reveal-story").innerHTML = `<p class="muted">You point a trembling finger at ${escapeHtml(s.name)}. Thunder shakes the manor…</p>`;
  flashLightning();

  try {
    const { correct, story, killer, stats } = await api("/api/accuse", {
      suspect: state.accused,
      reasoning: $("#reasoning").value,
    });
    record(`Final reveal: accused ${s.name}`, stats);
    flashLightning();
    $("#reveal-title").textContent = correct ? "Case Closed" : "The Killer Escapes";
    $("#reveal .modal-card").classList.toggle("win", correct);
    $("#reveal-story").innerHTML =
      prose(story) +
      (correct ? "" : `<p class="muted"><br>The true killer was <strong>${escapeHtml(killer)}</strong>.</p>`) +
      `<span class="meta">${escapeHtml(statLine(stats))}</span>`;
  } catch (e) {
    $("#reveal-title").textContent = "The spirits are silent";
    $("#reveal-story").textContent = e.message;
  }
}

// ---- rain ---------------------------------------------------------------------

function startRain() {
  const c = $("#rain");
  const ctx = c.getContext("2d");
  let drops = [];
  const resize = () => {
    c.width = innerWidth;
    c.height = innerHeight;
    drops = Array.from({ length: Math.floor(innerWidth / 6) }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height, l: 10 + Math.random() * 18, v: 8 + Math.random() * 8,
    }));
  };
  resize();
  addEventListener("resize", resize);
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "rgba(170,180,220,.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of drops) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 2, d.y + d.l);
      d.y += d.v;
      d.x -= 0.6;
      if (d.y > c.height) { d.y = -d.l; d.x = Math.random() * c.width; }
    }
    ctx.stroke();
    requestAnimationFrame(tick);
  })();
  setInterval(() => Math.random() < 0.35 && flashLightning(), 9000);
}

// ---- boot ----------------------------------------------------------------------

async function boot() {
  startRain();
  const data = await api("/api/case");
  window.MODELS = data.models;
  state.suspects = data.suspects;
  $("#setting").textContent = data.setting;
  $("#setting-2").textContent = data.setting;

  $("#enter").addEventListener("click", () => {
    flashLightning();
    $("#intro").classList.remove("active");
    $("#game").classList.add("active");
    renderSuspects();
    $("#scene-img").dataset.img = "scene";
    // Fire all six image jobs at once: Runpod fans them out across workers in parallel.
    paint("scene", "the crime scene");
    state.suspects.forEach((s) => paint(s.id, `portrait of ${s.name}`));
  });

  $("#notebook").value = localStorage.getItem("hollow-notebook") || "";
  $("#notebook").addEventListener("input", (e) => localStorage.setItem("hollow-notebook", e.target.value));
  $("#ask-form").addEventListener("submit", (e) => { e.preventDefault(); ask($("#question").value); });
  $("#toggle-log").addEventListener("click", () => $("#log").classList.toggle("hidden"));
  $("#close-log").addEventListener("click", () => $("#log").classList.add("hidden"));
  $("#open-accuse").addEventListener("click", openAccuse);
  $("#cancel-accuse").addEventListener("click", () => $("#accuse-modal").classList.add("hidden"));
  $("#confirm-accuse").addEventListener("click", confirmAccuse);
  $("#play-again").addEventListener("click", () => {
    localStorage.removeItem("hollow-notebook");
    location.reload();
  });
}

boot();
