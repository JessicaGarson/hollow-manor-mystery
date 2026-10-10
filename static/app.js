const $ = (sel) => document.querySelector(sel);

const state = {
  suspects: [],
  images: {},          // id -> url
  histories: {},       // suspect id -> [{role, content}]
  current: null,
  accused: null,
  log: [],
};

const CORONER_QUESTIONS = [
  "Examine the body. How did he die?",
  "What's in the absinthe glass?",
  "Examine the black feather.",
  "Any fingerprints on the glass?",
  "Anything on the desk?",
];

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
  const cost = stats.cost != null ? ` · $${stats.cost.toFixed(4)}` : stats.serverless ? " · billed per GPU-second" : "";
  const cold = stats.delayMs > 20000 ? ` · ❄️ cold start` : "";
  return `⚡ ${stats.endpoint} · queue ${fmtMs(stats.delayMs)}${cold} · run ${fmtMs(stats.executionMs)}${cost}`;
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
    }${stats.serverless ? " · <b>Runpod Serverless</b>" : ""}</div>
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

function character(id) {
  return id === "coroner" ? state.coroner : state.suspects.find((x) => x.id === id);
}

function renderSuspects() {
  const c = state.coroner;
  const crypt = `
    <div class="suspect crypt" data-id="coroner">
      <div class="portrait"><img data-img="coroner" alt="${escapeHtml(c.name)}"><div class="img-loading">painting portrait…</div></div>
      <h4>${escapeHtml(c.name)}</h4>
      <div class="title">${escapeHtml(c.title)}</div>
      <div class="crypt-status" id="crypt-status">💤 checking the crypt…</div>
    </div>`;
  $("#suspects").innerHTML = crypt + state.suspects
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
  const s = character(id);
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
  $("#bell").classList.toggle("hidden", id !== "coroner");

  const chat = $("#chat");
  chat.innerHTML = "";
  if (!state.histories[id].length) {
    addMsg(
      "assistant",
      id === "coroner"
        ? state.serverless
          ? "*A coffin rests in the cold crypt, lid shut. Ask a question to wake him.* He runs on a Runpod Serverless endpoint that scales to zero when nobody needs him, so if he's asleep, the first answer can take a minute or two while a GPU spins up. Ring the bell to wake him early."
          : "*The coroner looks up from his slab, wiping his hands on his apron.* Ask me about the evidence, detective."
        : `*${s.name} regards you warily from behind ${s.costume.split(",")[0]}.*`
    );
  }
  state.histories[id].forEach((m) => addMsg(m.role, m.content, m.stats));

  $("#chips").innerHTML = (id === "coroner" ? CORONER_QUESTIONS : QUICK_QUESTIONS).map((q) => `<button class="chip" type="button">${escapeHtml(q)}</button>`).join("");
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
  if (id === "coroner") return askCoroner(question);
  const s = character(id);
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

// ---- the Coroner: your own Serverless endpoint --------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cryptMood(h, jobStatus) {
  if (!h || !h.serverless) return { icon: "🕯️", text: "public endpoint fallback" };
  const w = h.workers || {};
  if (jobStatus === "IN_PROGRESS" || w.running > 0) return { icon: "💀", text: `Awake and examining (${w.running || 1} running)` };
  if (w.initializing > 0) return { icon: "⚰️", text: `Rising from the coffin… (${w.initializing} worker cold-starting)` };
  if (w.idle > 0 || w.ready > 0) return { icon: "🕯️", text: `Awake (${(w.idle || 0) + (w.ready || 0)} warm worker)` };
  return { icon: "💤", text: "Asleep in the crypt (0 workers · $0/hr)" };
}

async function refreshCrypt(jobStatus) {
  try {
    const h = await api("/api/coroner/health");
    const m = cryptMood(h, jobStatus);
    const el = $("#crypt-status");
    if (el) el.textContent = `${m.icon} ${m.text}`;
    return { h, m };
  } catch (e) {
    return { h: null, m: { icon: "❓", text: "crypt unreachable" } };
  }
}

async function askCoroner(question, warmup = false) {
  const c = state.coroner;
  const history = state.histories.coroner;
  $("#question").value = "";
  $("#ask-btn").disabled = true;
  $("#bell").disabled = true;
  if (!warmup) addMsg("user", question);
  const waiting = addMsg("assistant", "🔔 Ringing the crypt bell…", null, "thinking");
  const t0 = Date.now();

  try {
    const { jobId } = await api("/api/coroner", warmup
      ? { warmup: true }
      : { question, history: history.map(({ role, content }) => ({ role, content })) });

    let result = { status: "IN_QUEUE" };
    let tick = 0;
    while (!["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(result.status)) {
      await sleep(1500);
      result = await api(`/api/coroner/status/${jobId}`);
      if (tick++ % 2 === 0) {
        const { m } = await refreshCrypt(result.status);
        const secs = Math.round((Date.now() - t0) / 1000);
        const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
        const narr =
          result.status === "IN_PROGRESS"
            ? "💀 The coroner peers through his spectacles…"
            : m.icon === "⚰️"
            ? "⚰️ The coffin lid creaks open… (a GPU worker is booting and loading Qwen3-8B)"
            : "🔔 The bell tolls in the crypt… (job queued, waiting for a worker)";
        waiting.innerHTML = `${escapeHtml(narr)}<span class="meta">${escapeHtml(`job ${jobId.slice(0, 8)} · ${result.status} · ${clock}`)}</span>`;
      }
      if (Date.now() - t0 > 10 * 60 * 1000) throw new Error("He sleeps too deeply: still queued after 10 minutes");
    }
    waiting.remove();
    if (result.status !== "COMPLETED") throw new Error(result.error || result.status);

    const stats = { ...result.stats, roundTripMs: Date.now() - t0, serverless: state.serverless };
    if (warmup) {
      addMsg("assistant", "*The coffin lid slides open. Dr. Graves sits up, blinking.* I have risen. What do you want?", stats);
      record("Woke the Coroner (warm-up)", stats);
    } else {
      history.push({ role: "user", content: question }, { role: "assistant", content: result.answer, stats });
      addMsg("assistant", result.answer, stats);
      record(`Consulted ${c.name}`, stats);
    }
    flashLightning();
  } catch (e) {
    waiting.remove();
    addMsg("assistant", `The crypt stays silent… (${e.message})`, null, "error");
  } finally {
    $("#ask-btn").disabled = false;
    $("#bell").disabled = false;
    refreshCrypt();
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
  state.coroner = data.coroner;
  state.serverless = data.serverless;
  $("#setting").textContent = data.setting;
  $("#setting-2").textContent = data.setting;

  $("#enter").addEventListener("click", () => {
    flashLightning();
    $("#intro").classList.remove("active");
    $("#game").classList.add("active");
    renderSuspects();
    $("#scene-img").dataset.img = "scene";
    // Fire all seven image jobs at once: Runpod fans them out across workers in parallel.
    paint("scene", "the crime scene");
    state.suspects.forEach((s) => paint(s.id, `portrait of ${s.name}`));
    paint("coroner", "portrait of the Coroner");
    refreshCrypt();
    setInterval(() => !document.hidden && refreshCrypt(), 5000);
  });

  $("#notebook").value = localStorage.getItem("hollow-notebook") || "";
  $("#notebook").addEventListener("input", (e) => localStorage.setItem("hollow-notebook", e.target.value));
  $("#ask-form").addEventListener("submit", (e) => { e.preventDefault(); ask($("#question").value); });
  $("#toggle-log").addEventListener("click", () => $("#log").classList.toggle("hidden"));
  $("#close-log").addEventListener("click", () => $("#log").classList.add("hidden"));
  $("#open-accuse").addEventListener("click", openAccuse);
  $("#bell").addEventListener("click", () => askCoroner("", true));
  $("#cancel-accuse").addEventListener("click", () => $("#accuse-modal").classList.add("hidden"));
  $("#confirm-accuse").addEventListener("click", confirmAccuse);
  $("#play-again").addEventListener("click", () => {
    localStorage.removeItem("hollow-notebook");
    location.reload();
  });
}

boot();
