/**
 * C7 Reels: a full-screen, swipeable feed of play-money games.
 *
 * The shape is a reel — one game per screen, snap scrolling, an action rail and
 * a caption over the art. What is underneath is the server's coin flip at the
 * odds it publishes, so each card says so: eight names over one game is a skin,
 * not eight games, and a feed that implied otherwise would be the kind of claim
 * this codebase exists not to make.
 *
 * Nothing here decides an outcome. The server settles the round; `reelFaces`
 * turns that settled round into faces to show, matching on a win and never on a
 * loss. The transport is `playApi.js`, the client this API ships for front ends
 * built elsewhere, so this page exercises exactly what that file promises.
 */
import { PlayApi, reelFaces } from "./playApi.js";

const TOKEN_KEY = "c7_token";
const STAKES = [10, 25, 50, 100, 250, 500];

/** Skins over one game: faces, a ribbon, and art made of light rather than files. */
const THEMES = [
  {
    name: "Golden Hour", tag: "House classic",
    desc: "Bells, cherries and a seven that means it. The oldest shape a slot has.",
    faces: ["🔔", "🍒", "🍋", "⭐", "7️⃣", "💎"], ribbon: "CLASSIC",
    art: "radial-gradient(90% 60% at 50% 12%,rgba(240,201,74,.42),transparent 62%),"
       + "radial-gradient(70% 50% at 18% 78%,rgba(198,138,46,.35),transparent 60%),"
       + "linear-gradient(180deg,#3a2a06,#160f02 58%,#080600)",
  },
  {
    name: "Neon Alley", tag: "After dark",
    desc: "Wet asphalt, a sign that buzzes, and somebody winning two streets over.",
    faces: ["🌃", "🎲", "🍸", "💠", "🎯", "🪩"], ribbon: "AFTER DARK",
    art: "radial-gradient(80% 55% at 70% 18%,rgba(120,140,255,.4),transparent 62%),"
       + "radial-gradient(70% 50% at 22% 82%,rgba(255,90,190,.3),transparent 60%),"
       + "linear-gradient(180deg,#131a3f,#0a0c1e 58%,#04060f)",
  },
  {
    name: "Jungle Drop", tag: "Loud and green",
    desc: "Something moved in the canopy. It was probably the multiplier.",
    faces: ["🐍", "🌴", "🦜", "🍍", "🐆", "🥥"], ribbon: "WILD",
    art: "radial-gradient(85% 55% at 50% 14%,rgba(46,224,138,.38),transparent 62%),"
       + "radial-gradient(60% 45% at 80% 80%,rgba(240,201,74,.22),transparent 60%),"
       + "linear-gradient(180deg,#0b3a24,#062015 58%,#030d08)",
  },
  {
    name: "Deep Six", tag: "Down where it is quiet",
    desc: "Cold light, slow shapes, and a very patient house.",
    faces: ["🐙", "🐠", "🫧", "🦈", "🐚", "🧭"], ribbon: "DEEP",
    art: "radial-gradient(85% 60% at 50% 10%,rgba(80,190,255,.34),transparent 64%),"
       + "radial-gradient(70% 50% at 20% 85%,rgba(20,90,140,.4),transparent 60%),"
       + "linear-gradient(180deg,#062b40,#03141f 58%,#010a10)",
  },
  {
    name: "Ember Room", tag: "Warm and slow",
    desc: "One lamp, one drink, one more spin. The room does not hurry you.",
    faces: ["🔥", "🍷", "🥁", "🌶️", "🪔", "🎸"], ribbon: "LATE",
    art: "radial-gradient(85% 55% at 50% 14%,rgba(255,120,90,.36),transparent 62%),"
       + "radial-gradient(60% 45% at 78% 82%,rgba(240,201,74,.24),transparent 60%),"
       + "linear-gradient(180deg,#3a1410,#1c0806 58%,#0a0403)",
  },
  {
    name: "Frost Line", tag: "Cold and clean",
    desc: "Nothing melts here, least of all the house edge.",
    faces: ["❄️", "🧊", "🐧", "⛷️", "🥶", "💠"], ribbon: "FROST",
    art: "radial-gradient(85% 60% at 50% 12%,rgba(180,220,255,.34),transparent 62%),"
       + "radial-gradient(70% 50% at 22% 84%,rgba(90,150,220,.3),transparent 60%),"
       + "linear-gradient(180deg,#16324a,#0a1926 58%,#040b12)",
  },
  {
    name: "Night Market", tag: "Everything on a stick",
    desc: "Steam, lanterns, and a queue that knows something you do not.",
    faces: ["🍜", "🥟", "🧋", "🍡", "🏮", "🦐"], ribbon: "STREET",
    art: "radial-gradient(85% 55% at 50% 12%,rgba(255,180,90,.38),transparent 62%),"
       + "radial-gradient(65% 45% at 80% 82%,rgba(220,60,60,.3),transparent 60%),"
       + "linear-gradient(180deg,#3d1f0a,#1c0e05 58%,#0a0502)",
  },
  {
    name: "Orbit", tag: "Nothing but sky",
    desc: "Out here the odds are the same as they are on the ground.",
    faces: ["🛰️", "🪐", "🚀", "☄️", "🌙", "✨"], ribbon: "FAR OUT",
    art: "radial-gradient(80% 55% at 60% 14%,rgba(160,120,255,.4),transparent 62%),"
       + "radial-gradient(70% 50% at 20% 84%,rgba(60,200,220,.24),transparent 60%),"
       + "linear-gradient(180deg,#221540,#100a22 58%,#050310)",
  },
];

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");

let stored = null;
try { stored = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked; a session still works for this page load */ }

const api = new PlayApi({ baseUrl: "/api", token: stored });
let player = null;
let rules = null;
const cards = [];

function keepToken() {
  try {
    if (api.token) localStorage.setItem(TOKEN_KEY, api.token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing to persist to; the session lasts this page load */ }
}

/* ---------- wallet ---------- */

function paintWallet() {
  $("balance").textContent = player ? fmt(player.balance) : "—";
  $("faucet").hidden = !(player && player.faucetReadyAt === 0);
  for (const card of cards) card.paint();
}

async function claim() {
  $("faucet").disabled = true;
  try {
    player = await api.faucet();
  } catch (err) {
    // A cooldown is the ordinary case; the button hides itself until it lifts.
    if (err.nextClaimAt) player = { ...player, faucetReadyAt: err.nextClaimAt };
  } finally {
    $("faucet").disabled = false;
    paintWallet();
  }
}

/* ---------- sheets ---------- */

function openSheet(message = "") {
  $("sheet").hidden = false;
  $("authMsg").textContent = message;
  $("authMsg").className = message ? "msg bad" : "msg";
  $("username").focus();
}

function openInfo(title, html) {
  $("infoTitle").textContent = title;
  $("infoBody").innerHTML = html;
  $("info").hidden = false;
}

async function showFairness() {
  if (!player) return openSheet();
  openInfo("Provably fair", `
    <p>The server fixes each roll before you bet it, and publishes the fingerprint of the seed it will use. Reveal the seed and every past roll can be checked against it.</p>
    <div class="rows">
      <div class="rw"><span>Commitment</span><b class="mono">${player.commitment.slice(0, 24)}…</b></div>
      <div class="rw"><span>Your seed</span><b class="mono">${player.clientSeed}</b></div>
      <div class="rw"><span>Next bet</span><b>#${player.nonce}</b></div>
      <div class="rw"><span>Odds</span><b>${Math.round(rules.winChance * 100)}% · ×${payoutPerChip().toFixed(2)}</b></div>
    </div>`);
}

async function showLedger() {
  if (!player) return openSheet();
  const entries = await api.ledger().catch(() => []);
  const rows = entries.slice(0, 12).map((e) => {
    const mine = e.to.startsWith("player:");
    return `<div class="rw"><span>${e.reason}</span><b class="${mine ? "pos" : ""}">${mine ? "+" : "−"}${fmt(e.amount)}</b></div>`;
  }).join("");
  openInfo("Your last rounds", rows ? `<div class="rows">${rows}</div>` : "<p>Nothing yet. Spin something.</p>");
}

async function showLeaderboard() {
  const players = await api.leaderboard().catch(() => []);
  const rows = players.map((p, i) =>
    `<div class="rw"><span>${i + 1}. ${p.username}</span><b>${fmt(p.balance)} · ${p.rounds} rounds</b></div>`).join("");
  openInfo("Most chips", rows ? `<div class="rows">${rows}</div>` : "<p>Nobody has played yet.</p>");
}

function showAbout() {
  openInfo("What this is", `
    <p>Eight skins over one game: the server's coin flip, at the odds printed on every card. The art changes, the maths does not.</p>
    <p>Chips are issued free by a faucet. They have no cash value and cannot be bought, sold or cashed out — there is no deposit path and no withdrawal path in this build, not disabled ones, absent ones.</p>
    <div class="rows">
      <div class="rw"><span>Chance to win</span><b>${Math.round(rules.winChance * 100)}%</b></div>
      <div class="rw"><span>A win pays</span><b>×${payoutPerChip().toFixed(2)}</b></div>
      <div class="rw"><span>House edge</span><b>${(rules.houseEdge * 100).toFixed(0)}%</b></div>
    </div>`);
}

/* ---------- one reel ---------- */

function payoutPerChip() {
  return rules ? (1 - rules.houseEdge) / rules.winChance : 0;
}

function buildReel(theme, index) {
  const el = document.createElement("section");
  el.className = "reel";
  el.style.setProperty("--art", theme.art);
  el.innerHTML = `
    <div class="motif">${theme.faces[0]}</div>
    <div class="scrim"></div><div class="dust"></div>
    <div class="ribbon">${theme.ribbon}</div>
    <div class="topmeta"><span class="prov">C7</span><span>${Math.round((rules?.winChance ?? 0) * 100)}% · ×${payoutPerChip().toFixed(2)}</span></div>

    <div class="slotwrap">
      <div class="slot-head">
        <div class="slot-badge">PLAY MONEY · PROVABLY FAIR</div>
        <div class="slot-name">${theme.name}</div>
      </div>
      <div class="machine">
        <div class="row">
          <div class="cell"><span>${theme.faces[0]}</span></div>
          <div class="cell"><span>${theme.faces[1]}</span></div>
          <div class="cell"><span>${theme.faces[2]}</span></div>
        </div>
        <div class="winbanner"></div>
      </div>
      <div class="hud">
        <div class="hud-i"><span>BALANCE</span><b class="bal num">—</b></div>
        <div class="hud-i"><span>STAKE</span><b class="stk num">50</b></div>
        <div class="hud-i w"><span>LAST</span><b class="last num">—</b></div>
      </div>
      <div class="ctrls">
        <button class="betbtn down" aria-label="Lower the stake">−</button>
        <button class="spinbtn">SPIN</button>
        <button class="betbtn up" aria-label="Raise the stake">+</button>
      </div>
      <p class="slot-fine"></p>
    </div>

    <div class="rail">
      <button class="rbtn fair"><span>🔒</span><b>Fair</b></button>
      <button class="rbtn ledger"><span>🧾</span><b>Rounds</b></button>
      <button class="rbtn board"><span>🏆</span><b>Top</b></button>
      <button class="rbtn about"><span>ⓘ</span><b>About</b></button>
    </div>

    <div class="caption">
      <div class="ctitle">${theme.name}</div>
      <p class="cdesc">${theme.desc}</p>
      <div class="tagline"><i>#${theme.tag.replace(/\s+/g, "")}</i><i>#playmoney</i><i>#provablyfair</i></div>
    </div>
    ${index === 0 ? '<div class="swipe">swipe up for the next game ↑</div>' : ""}
  `;

  const machine = el.querySelector(".machine");
  const cells = [...el.querySelectorAll(".cell")];
  const faces = cells.map((cell) => cell.firstElementChild);
  const banner = el.querySelector(".winbanner");
  const spin = el.querySelector(".spinbtn");
  const fine = el.querySelector(".slot-fine");
  let stakeIndex = 2;
  let last = null;

  const card = {
    el,
    paint() {
      el.querySelector(".bal").textContent = player ? fmt(player.balance) : "—";
      el.querySelector(".stk").textContent = fmt(STAKES[stakeIndex]);
      el.querySelector(".last").textContent =
        last === null ? "—" : last > 0 ? `+${fmt(last)}` : `−${fmt(-last)}`;
      fine.innerHTML = player
        ? `Same coin flip under every skin · next roll committed to <b>${player.commitment.slice(0, 12)}…</b>`
        : "Sign in to spin. Chips are free and have no cash value.";
    },
  };

  el.querySelector(".down").addEventListener("click", () => {
    stakeIndex = Math.max(0, stakeIndex - 1);
    card.paint();
  });
  el.querySelector(".up").addEventListener("click", () => {
    stakeIndex = Math.min(STAKES.length - 1, stakeIndex + 1);
    card.paint();
  });
  el.querySelector(".fair").addEventListener("click", showFairness);
  el.querySelector(".ledger").addEventListener("click", showLedger);
  el.querySelector(".board").addEventListener("click", showLeaderboard);
  el.querySelector(".about").addEventListener("click", showAbout);

  spin.addEventListener("click", async () => {
    if (!player) return openSheet();
    spin.disabled = true;
    machine.classList.remove("won");
    banner.classList.remove("show");
    for (const cell of cells) cell.classList.remove("hit");
    for (const cell of cells) cell.classList.add("spinning");

    // The faces churn while the request is in flight; where they land is the
    // server's answer, never this page's.
    const churn = setInterval(() => {
      for (const face of faces) {
        face.textContent = theme.faces[Math.floor(Math.random() * theme.faces.length)];
      }
    }, 65);

    const started = Date.now();
    try {
      const round = await api.bet(STAKES[stakeIndex]);
      const shown = reelFaces(round, theme.faces.length, cells.length);
      // A spin that resolves instantly is still shown as a spin.
      await new Promise((done) => setTimeout(done, Math.max(0, 700 - (Date.now() - started))));
      clearInterval(churn);
      cells.forEach((cell, i) => {
        cell.classList.remove("spinning");
        faces[i].textContent = theme.faces[shown[i]];
        if (round.won) setTimeout(() => cell.classList.add("hit"), i * 90);
      });
      last = round.net;
      player = { ...player, balance: round.balance, nonce: round.nonce + 1 };
      if (round.won) {
        machine.classList.add("won");
        banner.textContent = `+${fmt(round.payout - round.stake)}`;
        setTimeout(() => banner.classList.add("show"), 260);
        setTimeout(() => banner.classList.remove("show"), 1800);
      }
      paintWallet();
    } catch (err) {
      clearInterval(churn);
      for (const cell of cells) cell.classList.remove("spinning");
      if (err.status === 401) {
        api.token = null;
        keepToken();
        player = null;
        paintWallet();
        openSheet("Your session expired. Sign in again.");
      } else {
        // A stake the balance cannot cover comes back carrying the balance.
        if (typeof err.balance === "number") player = { ...player, balance: err.balance };
        fine.textContent = err.message;
        paintWallet();
      }
    } finally {
      spin.disabled = false;
    }
  });

  return card;
}

/* ---------- sign-in ---------- */

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
    if (player.balance === 0 && player.faucetReadyAt === 0) await claim();
  } catch (err) {
    msg.className = "msg bad";
    msg.textContent = err.message;
  }
}

/* ---------- start ---------- */

async function start() {
  const status = await api.status().catch(() => null);
  rules = status?.rules ?? { winChance: 0.5, houseEdge: 0.02 };

  const stage = $("stage");
  const segbar = $("segbar");
  THEMES.forEach((theme, index) => {
    const card = buildReel(theme, index);
    cards.push(card);
    stage.append(card.el);
    segbar.insertAdjacentHTML("beforeend", "<i><b></b></i>");
  });

  // The progress bar fills as you get to each reel, the way a story does.
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = cards.findIndex((card) => card.el === entry.target);
      for (let i = 0; i <= index; i++) segbar.children[i].classList.add("seen");
    }
  }, { threshold: 0.6 });
  for (const card of cards) seen.observe(card.el);

  if (api.token) {
    try {
      player = await api.me();
    } catch {
      api.token = null;
      keepToken();
    }
  }
  paintWallet();
  if (!player) openSheet();
}

$("faucet").addEventListener("click", claim);
$("register").addEventListener("click", () => authenticate("register"));
$("login").addEventListener("click", () => authenticate("login"));
$("password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") authenticate("login");
});
$("infoClose").addEventListener("click", () => { $("info").hidden = true; });
$("info").addEventListener("click", (event) => {
  if (event.target === $("info")) $("info").hidden = true;
});

start();
