/**
 * C7 Reels: a swipeable feed of slot skins over the play-money API.
 *
 * Every theme here is the same game — the server's coin flip, at the odds it
 * publishes — wearing different faces. Saying so on each card is deliberate: a
 * feed of "24 games" that are one game underneath would be the sort of claim
 * this codebase exists not to make.
 *
 * The reels decide nothing. The server settles the round, and `reelFaces` turns
 * that settled round into faces to show, matching on a win and never on a loss.
 *
 * The transport is `playApi.js`, the same client the API ships for front ends
 * built elsewhere, so this page exercises exactly what that file promises.
 */
import { PlayApi, reelFaces } from "./playApi.js";

const TOKEN_KEY = "c7_token";
const STAKES = [10, 50, 100, 500];

/**
 * Skins, not games. Each is a set of faces and a glow; the odds underneath are
 * whatever /api/status reports, identically for all of them.
 */
const THEMES = [
  { name: "Golden Hour", note: "Classic bells and sevens", faces: ["🔔", "🍋", "🍒", "⭐", "7️⃣", "💎"], glow: "rgba(240,201,74,.20)", accent: "#f0c94a" },
  { name: "Neon Alley", note: "After dark on the strip", faces: ["🌃", "🎲", "🍸", "💠", "🎯", "🪩"], glow: "rgba(120,140,255,.18)", accent: "#8fa2ff" },
  { name: "Jungle Drop", note: "Deep green and loud", faces: ["🐍", "🌴", "🦜", "🍍", "🐆", "🥥"], glow: "rgba(46,224,138,.16)", accent: "#2ee08a" },
  { name: "Deep Six", note: "Down where it is quiet", faces: ["🐙", "🐠", "🫧", "🦈", "🐚", "🧭"], glow: "rgba(80,190,255,.16)", accent: "#5cc8ff" },
  { name: "Ember Room", note: "Warm, slow, red", faces: ["🔥", "🍷", "🥁", "🌶️", "🪔", "🎸"], glow: "rgba(255,107,125,.16)", accent: "#ff8a7d" },
  { name: "Frost Line", note: "Cold and clean", faces: ["❄️", "🧊", "🐧", "⛷️", "🥶", "💠"], glow: "rgba(180,220,255,.16)", accent: "#bcdcff" },
  { name: "Night Market", note: "Everything on a stick", faces: ["🍜", "🥟", "🧋", "🍡", "🏮", "🦐"], glow: "rgba(255,180,90,.16)", accent: "#ffb45a" },
  { name: "Orbit", note: "Nothing but sky", faces: ["🛰️", "🪐", "🚀", "☄️", "🌙", "✨"], glow: "rgba(160,120,255,.18)", accent: "#b08cff" },
];

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");

let stored = null;
try { stored = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked; a session still works for this page load */ }

const api = new PlayApi({ baseUrl: "/api", token: stored });
let player = null;
let rules = null;

function keepToken() {
  try {
    if (api.token) localStorage.setItem(TOKEN_KEY, api.token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing to persist to; the session lasts this page load */ }
}

/* ---------- header ---------- */

function paintWallet() {
  $("balance").textContent = player ? fmt(player.balance) : "—";
  const ready = player !== null && player.faucetReadyAt === 0;
  $("faucet").hidden = !ready;
}

async function claim() {
  const button = $("faucet");
  button.disabled = true;
  try {
    player = await api.faucet();
    paintWallet();
  } catch (err) {
    // A cooldown is the ordinary case, and the button simply goes away until it lifts.
    if (err.nextClaimAt) player = { ...player, faucetReadyAt: err.nextClaimAt };
    paintWallet();
  } finally {
    button.disabled = false;
  }
}

/* ---------- one card ---------- */

function payoutPerChip() {
  return rules ? (1 - rules.houseEdge) / rules.winChance : 0;
}

function buildReel(theme) {
  const card = document.createElement("section");
  card.className = "reel";
  card.style.setProperty("--glow", theme.glow);
  card.style.setProperty("--accent", theme.accent);

  const odds = rules
    ? `${Math.round(rules.winChance * 100)}% to win · pays ×${payoutPerChip().toFixed(2)}`
    : "";
  card.innerHTML = `
    <div class="name">
      <h2>${theme.name}</h2>
      <p>${theme.note} · ${odds}</p>
    </div>
    <div class="window">
      <div class="slot"><span>${theme.faces[0]}</span></div>
      <div class="slot"><span>${theme.faces[1]}</span></div>
      <div class="slot"><span>${theme.faces[2]}</span></div>
    </div>
    <p class="verdict"></p>
    <div class="stakes"></div>
    <button class="spin">SPIN</button>
    <p class="fair"></p>
  `;

  const machine = card.querySelector(".window");
  const slots = [...card.querySelectorAll(".slot span")];
  const verdict = card.querySelector(".verdict");
  const spin = card.querySelector(".spin");
  const fair = card.querySelector(".fair");
  let stake = STAKES[1];

  const stakes = card.querySelector(".stakes");
  for (const amount of STAKES) {
    const button = document.createElement("button");
    button.textContent = fmt(amount);
    button.setAttribute("aria-pressed", String(amount === stake));
    button.addEventListener("click", () => {
      stake = amount;
      for (const other of stakes.children) {
        other.setAttribute("aria-pressed", String(other === button));
      }
    });
    stakes.append(button);
  }

  function paintFairness() {
    if (!player) {
      fair.textContent = "Sign in to spin. Chips are free and have no cash value.";
      return;
    }
    fair.innerHTML =
      `Next roll is committed to <b class="mono">${player.commitment.slice(0, 16)}…</b>` +
      `<br>bet #${player.nonce} on seed <b class="mono">${player.clientSeed}</b>`;
  }
  paintFairness();
  card.paintFairness = paintFairness;

  spin.addEventListener("click", async () => {
    if (!player) return openSheet();
    spin.disabled = true;
    machine.classList.remove("won", "lost");
    verdict.textContent = "";
    verdict.className = "verdict";
    for (const slot of slots) slot.parentElement.classList.add("spin");

    // Faces churn while the request is in flight; what they land on is the
    // server's answer, never this page's.
    const churn = setInterval(() => {
      for (const slot of slots) {
        slot.textContent = theme.faces[Math.floor(Math.random() * theme.faces.length)];
      }
    }, 70);

    const started = Date.now();
    try {
      const round = await api.bet(stake);
      const faces = reelFaces(round, theme.faces.length, slots.length);
      // Let the spin read as a spin even when the server answers instantly.
      const wait = Math.max(0, 620 - (Date.now() - started));
      await new Promise((done) => setTimeout(done, wait));
      clearInterval(churn);
      slots.forEach((slot, index) => {
        slot.parentElement.classList.remove("spin");
        slot.textContent = theme.faces[faces[index]];
      });
      machine.classList.add(round.won ? "won" : "lost");
      verdict.textContent = round.won ? `WIN +${fmt(round.payout - round.stake)}` : `−${fmt(round.stake)}`;
      verdict.className = `verdict ${round.won ? "won" : "lost"}`;
      // `round.nonce` is the one this roll used; the line below names the next.
      player = { ...player, balance: round.balance, nonce: round.nonce + 1 };
      paintWallet();
      for (const other of document.querySelectorAll(".reel")) other.paintFairness?.();
    } catch (err) {
      clearInterval(churn);
      for (const slot of slots) slot.parentElement.classList.remove("spin");
      if (err.status === 401) {
        api.token = null;
        keepToken();
        player = null;
        paintWallet();
        openSheet("Your session expired. Sign in again.");
      } else {
        verdict.textContent = err.message;
        verdict.className = "verdict lost";
        // A stake the balance cannot cover comes back with the balance in it.
        if (typeof err.balance === "number") {
          player = { ...player, balance: err.balance };
          paintWallet();
        }
      }
    } finally {
      spin.disabled = false;
    }
  });

  return card;
}

/* ---------- sign-in ---------- */

function openSheet(message = "") {
  $("sheet").hidden = false;
  $("authMsg").textContent = message;
  $("authMsg").className = message ? "msg bad" : "msg";
  $("username").focus();
}

async function authenticate(kind) {
  const username = $("username").value.trim();
  const password = $("password").value;
  const msg = $("authMsg");
  msg.className = "msg";
  msg.textContent = "One moment…";
  try {
    player = kind === "register"
      ? await api.register(username, password)
      : await api.login(username, password);
    keepToken();
    $("sheet").hidden = true;
    paintWallet();
    for (const card of document.querySelectorAll(".reel")) card.paintFairness?.();
    if (player.balance === 0 && player.faucetReadyAt === 0) await claim();
  } catch (err) {
    msg.className = "msg bad";
    msg.textContent = err.message;
  }
}

/* ---------- start ---------- */

async function start() {
  const status = await api.status().catch(() => null);
  rules = status?.rules ?? null;

  const feed = $("feed");
  for (const theme of THEMES) feed.append(buildReel(theme));

  if (api.token) {
    try {
      player = await api.me();
    } catch {
      api.token = null;
      keepToken();
    }
  }
  paintWallet();
  for (const card of document.querySelectorAll(".reel")) card.paintFairness?.();
  if (!player) openSheet();
}

$("faucet").addEventListener("click", claim);
$("register").addEventListener("click", () => authenticate("register"));
$("login").addEventListener("click", () => authenticate("login"));
$("password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") authenticate("login");
});

start();
