/**
 * C7 Chip Room front end.
 *
 * The game logic is not reimplemented here — this module imports the same
 * compiled core the test suite covers, so the rolls a player verifies in the
 * browser come from exactly the code that was tested.
 */
import { PlayCasino } from "./core/casino.js";
import { verifyCommitment, generateServerSeed } from "./core/game.js";
import { FaucetCooldownError } from "./core/faucet.js";
import { HOUSE, playerAccount } from "./core/accounts.js";

const USER = "you";
const ACCOUNT = playerAccount(USER);
const FAUCET_AMOUNT = 1000;
const COOLDOWN_MS = 60_000;
const STORE = "c7_chiproom_v2";

const casino = new PlayCasino({ faucetAmount: FAUCET_AMOUNT, faucetCooldownMs: COOLDOWN_MS });
let clientSeed = generateServerSeed(8);
let commitHex = "";

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");

/* ---------- persistence ---------- */
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ snap: casino.snapshot(), clientSeed }));
  } catch { /* private window or blocked storage: the page works, it just forgets */ }
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORE); } catch { return; }
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved?.snap) casino.restore(saved.snap);
    if (typeof saved?.clientSeed === "string" && saved.clientSeed) clientSeed = saved.clientSeed;
  } catch (err) {
    // A snapshot that fails its own integrity checks is discarded rather than
    // patched up — a half-trusted ledger is worse than a fresh one.
    console.warn("Discarding unusable saved state:", err.message);
    try { localStorage.removeItem(STORE); } catch { /* nothing more to do */ }
  }
}

/* ---------- rendering ---------- */
function sessionStats() {
  let rounds = 0, wagered = 0, returned = 0;
  for (const e of casino.auditLog()) {
    if (e.reason === "bet") { rounds++; wagered += e.amount; }
    if (e.reason === "payout") returned += e.amount;
  }
  return { rounds, wagered, returned, net: returned - wagered };
}

function renderLedger() {
  const log = casino.auditLog();
  const body = $("ledger");
  if (!log.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Claim your chips to start the ledger.</td></tr>';
    return;
  }
  const running = new Map();
  let bal = 0;
  for (const e of log) {
    if (e.from === ACCOUNT) bal -= e.amount;
    if (e.to === ACCOUNT) bal += e.amount;
    running.set(e.seq, bal);
  }
  const label = (a) => (a === ACCOUNT ? "you" : a === HOUSE ? "house" : "mint");
  body.innerHTML = log.slice(-25).reverse().map((e) => `
    <tr>
      <td class="mono num" style="color:var(--mut)">${e.seq}</td>
      <td class="mono">${label(e.from)} → ${label(e.to)}</td>
      <td><span class="tag ${e.reason}">${e.reason}</span></td>
      <td class="amt">${fmt(e.amount)}</td>
      <td class="amt num" style="color:var(--mut)">${fmt(running.get(e.seq) ?? 0)}</td>
    </tr>`).join("");
}

function renderFaucet() {
  const btn = $("faucet");
  const next = casino.faucetReadyAt(USER);
  const left = next - Date.now();
  if (left > 0) {
    btn.disabled = true;
    btn.textContent = `Next claim in ${Math.ceil(left / 1000)}s`;
    $("faucetNote").textContent = "One claim per minute";
  } else {
    btn.disabled = false;
    btn.textContent = `Claim ${fmt(FAUCET_AMOUNT)} chips`;
    $("faucetNote").textContent = "Free chips, no payment";
  }
}

function render() {
  const balance = casino.balanceOf(USER);
  $("balance").textContent = fmt(balance);
  const issued = casino.chipsInCirculation();
  $("circ").textContent = issued
    ? `${fmt(issued)} chips issued to you by the faucet`
    : "No chips issued yet";

  const s = sessionStats();
  $("sRounds").textContent = fmt(s.rounds);
  $("sWagered").textContent = fmt(s.wagered);
  const net = $("sNet");
  net.textContent = (s.net > 0 ? "+" : "") + fmt(s.net);
  net.className = "v num" + (s.net > 0 ? " up" : s.net < 0 ? " down" : "");
  $("sRtp").textContent = s.wagered ? `${((s.returned / s.wagered) * 100).toFixed(1)}%` : "—";

  $("nonce").textContent = String(casino.nextNonce(USER));
  $("clientSeed").value = clientSeed;
  $("stake").max = String(Math.max(1, balance));
  $("bet").disabled = balance < 1;

  let healthy = true;
  try { casino.assertHealthy(); } catch { healthy = false; }
  $("reconcile").textContent = healthy
    ? "Every movement is double-entry, so the books always sum to zero. ✓ reconciled"
    : "⚠ books do not reconcile — this should be impossible";

  renderLedger();
  renderFaucet();
}

/* ---------- actions ---------- */
function showResult(kind, verdict, detailHtml) {
  const box = $("result");
  box.className = `result show ${kind}`;
  $("verdict").textContent = verdict;
  $("detail").innerHTML = detailHtml;
}

$("faucet").addEventListener("click", () => {
  try {
    casino.claimFaucet(USER);
    save();
  } catch (err) {
    if (!(err instanceof FaucetCooldownError)) throw err;
  }
  render();
});

let betting = false;
$("bet").addEventListener("click", async () => {
  if (betting) return;
  const stake = Math.floor(Number($("stake").value));
  const balance = casino.balanceOf(USER);
  if (!Number.isSafeInteger(stake) || stake < 1) {
    showResult("lose", "Can't place that bet", "Enter a whole number of chips.");
    return;
  }
  if (stake > balance) {
    showResult("lose", "Can't place that bet", `You only have ${fmt(balance)} chips.`);
    return;
  }

  betting = true;
  $("bet").disabled = true;
  try {
    const r = await casino.bet(USER, stake, clientSeed);
    showResult(
      r.won ? "win" : "lose",
      r.won ? `Won +${fmt(r.net)}` : `Lost ${fmt(r.net)}`,
      `roll <span class="mono">${r.roll.toFixed(8)}</span> ${r.won ? "&lt;" : "≥"} 0.5 · ` +
        `nonce <span class="mono">${r.nonce}</span> · balance <span class="mono">${fmt(r.balance)}</span>`,
    );
    save();
  } finally {
    betting = false;
    render();
  }
});

$("clientSeed").addEventListener("change", (ev) => {
  clientSeed = ev.target.value.trim() || generateServerSeed(8);
  save();
  render();
});

$("newSeed").addEventListener("click", async () => {
  casino.rotateServerSeed();
  clientSeed = generateServerSeed(8);
  commitHex = await casino.seedCommitment();
  $("commit").textContent = commitHex;
  $("seed").textContent = "hidden until you reveal";
  $("verifyBox").className = "verify";
  save();
  render();
});

$("reveal").addEventListener("click", async () => {
  const seed = casino.revealServerSeed();
  $("seed").textContent = seed;
  const ok = await verifyCommitment(seed, commitHex);
  const box = $("verifyBox");
  box.className = `verify show ${ok ? "ok" : "bad"}`;
  box.textContent = ok
    ? "✓ SHA-256 of the revealed seed matches the commitment published before you bet. Every roll above can be recomputed from it."
    : "✗ The revealed seed does not match the commitment.";
});

$("reset").addEventListener("click", async () => {
  try { localStorage.removeItem(STORE); } catch { /* nothing to clear */ }
  casino.restore({ entries: [], nonces: {}, lastClaims: {}, serverSeed: generateServerSeed() });
  casino.rotateServerSeed();
  clientSeed = generateServerSeed(8);
  commitHex = await casino.seedCommitment();
  $("commit").textContent = commitHex;
  $("seed").textContent = "hidden until you reveal";
  $("verifyBox").className = "verify";
  $("result").className = "result";
  save();
  render();
});

const QUICK = [10, 50, 100, 500, "MAX"];
$("quick").innerHTML = QUICK.map(
  (q) => `<button class="chip" data-q="${q}" aria-pressed="false">${q === "MAX" ? "Max" : fmt(q)}</button>`,
).join("");
$("quick").addEventListener("click", (ev) => {
  const b = ev.target.closest(".chip");
  if (!b) return;
  $("stake").value = b.dataset.q === "MAX" ? String(Math.max(1, casino.balanceOf(USER))) : b.dataset.q;
  for (const el of $("quick").children) el.setAttribute("aria-pressed", String(el === b));
});

/* ---------- boot ---------- */
load();
commitHex = await casino.seedCommitment();
$("commit").textContent = commitHex;
render();
setInterval(renderFaucet, 1000);
