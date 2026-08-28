/**
 * C7 Chip Room front end.
 *
 * All game state lives on the server: this file renders it and sends actions.
 * Nothing here decides an outcome, which is the point — the server seed stays
 * server-side, so the published commitment is a promise the client can check
 * rather than one it makes to itself.
 */

const TOKEN_KEY = "c7_token";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");

let token = null;
let state = null;      // the last /api/me payload
let commitment = "";

try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked; sign-in still works */ }

/* ---------- transport ---------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(json.error ?? `Request failed (${res.status})`), {
    status: res.status,
    payload: json,
  });
  return json;
}

function setToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing to persist to; the session lasts this page load */ }
}

/* ---------- rendering ---------- */
function showSignedOut(message) {
  state = null;
  $("authCard").style.display = "";
  $("playArea").style.display = "none";
  if (message) {
    const box = $("authMsg");
    box.className = "verify show bad";
    box.textContent = message;
  }
  void renderLeaderboard();
}

function renderMe(me) {
  state = me;
  commitment = me.commitment;
  $("authCard").style.display = "none";
  $("playArea").style.display = "";

  $("balance").textContent = fmt(me.balance);
  $("circ").textContent = `signed in as ${me.username}`;
  $("nonce").textContent = String(me.nonce);
  $("commit").textContent = me.commitment;
  $("clientSeed").value = me.clientSeed;
  $("stake").max = String(Math.max(1, me.balance));
  $("bet").disabled = me.balance < 1;
  renderFaucet();
}

function renderFaucet() {
  if (!state) return;
  const btn = $("faucet");
  const left = (state.faucetReadyAt || 0) - Date.now();
  if (left > 0) {
    btn.disabled = true;
    btn.textContent = `Next claim in ${Math.ceil(left / 1000)}s`;
    $("faucetNote").textContent = "One claim per minute";
  } else {
    btn.disabled = false;
    btn.textContent = `Claim ${fmt(state.faucetAmount)} chips`;
    $("faucetNote").textContent = "Free chips, no payment";
  }
}

async function renderLedger() {
  if (!state) return;
  const { entries } = await api("GET", "/api/ledger");
  const body = $("ledger");
  if (!entries.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Claim your chips to start the ledger.</td></tr>';
    return;
  }
  const mine = `player:${state.username}`;
  const label = (a) => (a === mine ? "you" : a === "system:house" ? "house" : "mint");
  body.innerHTML = entries.map((e) => `
    <tr>
      <td class="mono num" style="color:var(--mut)">${e.seq}</td>
      <td class="mono">${label(e.from)} → ${label(e.to)}</td>
      <td><span class="tag ${e.reason}">${e.reason}</span></td>
      <td class="amt">${fmt(e.amount)}</td>
      <td class="amt num" style="color:var(--mut)">${e.to === mine ? "+" : "−"}${fmt(e.amount)}</td>
    </tr>`).join("");
}

async function renderLeaderboard() {
  const { players } = await api("GET", "/api/leaderboard");
  const body = $("board");
  if (!players.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">No players yet.</td></tr>';
    return;
  }
  body.innerHTML = players.map((p, i) => `
    <tr>
      <td class="mono num" style="color:var(--mut)">${i + 1}</td>
      <td${state && p.username === state.username ? ' style="color:var(--gold);font-weight:800"' : ""}>${p.username}</td>
      <td class="amt num">${fmt(p.rounds)}</td>
      <td class="amt num">${fmt(p.balance)}</td>
    </tr>`).join("");
}

function renderStats(entries) {
  let rounds = 0, wagered = 0, returned = 0;
  for (const e of entries) {
    if (e.reason === "bet") { rounds++; wagered += e.amount; }
    if (e.reason === "payout") returned += e.amount;
  }
  $("sRounds").textContent = fmt(rounds);
  $("sWagered").textContent = fmt(wagered);
  const net = returned - wagered;
  const el = $("sNet");
  el.textContent = (net > 0 ? "+" : "") + fmt(net);
  el.className = "v num" + (net > 0 ? " up" : net < 0 ? " down" : "");
  $("sRtp").textContent = wagered ? `${((returned / wagered) * 100).toFixed(1)}%` : "—";
}

async function refresh() {
  const me = await api("GET", "/api/me");
  renderMe(me);
  const { entries } = await api("GET", "/api/ledger");
  renderStats(entries);
  await renderLedger();
  await renderLeaderboard();
}

/** Runs an action, sending the viewer back to sign-in if the session lapsed. */
async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) {
      setToken(null);
      showSignedOut("Your session expired. Sign in again.");
      return;
    }
    throw err;
  }
}

function showResult(kind, verdict, detailHtml) {
  const box = $("result");
  box.className = `result show ${kind}`;
  $("verdict").textContent = verdict;
  $("detail").innerHTML = detailHtml;
}

/* ---------- actions ---------- */
async function authenticate(path) {
  const username = $("username").value.trim();
  const password = $("password").value;
  const box = $("authMsg");
  try {
    const me = await api("POST", path, { username, password });
    setToken(me.token);
    box.className = "verify";
    $("password").value = "";
    renderMe(me);
    await refresh();
  } catch (err) {
    box.className = "verify show bad";
    box.textContent = err.message;
  }
}

$("login").addEventListener("click", () => authenticate("/api/login"));
$("registerBtn").addEventListener("click", () => authenticate("/api/register"));
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") authenticate("/api/login"); });

$("logout").addEventListener("click", async () => {
  try { await api("POST", "/api/logout", {}); } catch { /* the token is going away regardless */ }
  setToken(null);
  showSignedOut(null);
});

$("faucet").addEventListener("click", () => guarded(async () => {
  try {
    renderMe(await api("POST", "/api/faucet", {}));
  } catch (err) {
    if (err.status !== 429) throw err;
    state = { ...state, faucetReadyAt: err.payload.nextClaimAt };
    renderFaucet();
    return;
  }
  await refresh();
}));

let betting = false;
$("bet").addEventListener("click", () => guarded(async () => {
  if (betting) return;
  const stake = Math.floor(Number($("stake").value));
  if (!Number.isSafeInteger(stake) || stake < 1) {
    showResult("lose", "Can't place that bet", "Enter a whole number of chips.");
    return;
  }
  betting = true;
  $("bet").disabled = true;
  try {
    const r = await api("POST", "/api/bet", { stake, clientSeed: $("clientSeed").value.trim() });
    showResult(
      r.won ? "win" : "lose",
      r.won ? `Won +${fmt(r.net)}` : `Lost ${fmt(r.net)}`,
      `roll <span class="mono">${r.roll.toFixed(8)}</span> ${r.won ? "&lt;" : "≥"} 0.5 · ` +
        `nonce <span class="mono">${r.nonce}</span> · balance <span class="mono">${fmt(r.balance)}</span>`,
    );
  } catch (err) {
    if (err.status !== 400) throw err;
    showResult("lose", "Can't place that bet", err.message);
  } finally {
    betting = false;
    await refresh();
  }
}));

$("reveal").addEventListener("click", () => guarded(async () => {
  const { revealedSeed, commitment: next } = await api("POST", "/api/fairness/reveal", {});
  $("seed").textContent = revealedSeed;
  const box = $("verifyBox");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(revealedSeed));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ok = hex === commitment;
  box.className = `verify show ${ok ? "ok" : "bad"}`;
  box.textContent = ok
    ? "✓ The revealed seed hashes to the commitment published before you bet. Every roll can be recomputed from it. A fresh seed is now in play."
    : "✗ The revealed seed does not match the commitment that was published.";
  commitment = next;
  $("commit").textContent = next;
  await refresh();
}));

$("newSeed").addEventListener("click", () => guarded(async () => {
  const seed = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  renderMe(await api("POST", "/api/fairness/client-seed", { clientSeed: seed }));
}));

$("clientSeed").addEventListener("change", (ev) => guarded(async () => {
  const seed = ev.target.value.trim();
  if (!seed) return;
  renderMe(await api("POST", "/api/fairness/client-seed", { clientSeed: seed }));
}));

const QUICK = [10, 50, 100, 500, "MAX"];
$("quick").innerHTML = QUICK.map(
  (q) => `<button class="chip" data-q="${q}" aria-pressed="false">${q === "MAX" ? "Max" : fmt(q)}</button>`,
).join("");
$("quick").addEventListener("click", (ev) => {
  const b = ev.target.closest(".chip");
  if (!b) return;
  $("stake").value = b.dataset.q === "MAX" ? String(Math.max(1, state?.balance ?? 1)) : b.dataset.q;
  for (const el of $("quick").children) el.setAttribute("aria-pressed", String(el === b));
});

/* ---------- boot ---------- */
if (token) {
  refresh().catch(() => { setToken(null); showSignedOut(null); });
} else {
  showSignedOut(null);
}
setInterval(renderFaucet, 1000);
