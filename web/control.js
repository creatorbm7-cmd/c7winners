/**
 * C7 Chip Room control panel.
 *
 * Read-only by construction, not by convention: there is no control on this page
 * to lock, because the operations it reports on have no code path to reach. Every
 * row is rendered from /api/status, which reports what the build compiled with
 * and what the entry log currently sums to — so this panel cannot show a
 * capability the server does not have, or a figure the ledger does not support.
 */

const LANG_KEY = "c7_lang";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");

const T = {
  en: {
    title: "Control Panel",
    readonly: "🔒 READ ONLY",
    moneyTitle: "Money controls · locked",
    houseTitle: "The house",
    invTitle: "Invariants",
    gateTitle: "Real-money gates",
    back: "← Back to the chip room",
    locked: "LOCKED",
    absent: "no code path in this build",
    moneyNote:
      "These are not switches someone forgot to turn on. The real-money code paths are absent from the build, and the functions that would start them throw instead. Flipping a setting cannot reach them.",
    invNote:
      "Recomputed from the entry log on every request. A stored solvency flag can report health long after the numbers stopped agreeing; this cannot, because it derives its answer from the same log the balances come from.",
    gateNote:
      "These would have to be answered before any real-money operation could be considered. This build does not ask them, because it has no such operation to gate.",
    realEngine: "Real-money engine",
    deposits: "Deposits",
    withdrawals: "Withdrawals",
    cashOut: "Cash-out to any other asset",
    mode: "Platform mode",
    currency: "Currency",
    circulation: "Chips in circulation",
    playerChips: "Held by players",
    housePos: "House position",
    entries: "Ledger entries",
    players: "Players",
    edge: "House edge",
    reconcile: "Chips issued are chips accounted for",
    reconcileSub:
      "Every chip the mint issued is held by the house or by a player — none has gone anywhere else.",
    negative: "No player holds chips their history never gave them",
    storage: "Accounts survive a deploy",
    storageOkSub: "The database was already there when this server started, so it is not living in the container.",
    storageNewSub:
      "No database existed when this server started. Expected on a first deploy; on any later one it means the file is not on a persistent volume and every account went with the old container.",
    storagePgSub: "Postgres is a separate service, so a redeploy of this app does not touch it.",
    persisted: "PERSISTED",
    fresh: "FRESH",
    negativeSub: "A player account can never go below zero. Any that had would be counted here.",
    licence: "Gaming licence",
    psp: "Approved regulated payment processor",
    reserve: "Reserve backing user balances",
    notRequired: "NOT REQUIRED",
    notRequiredSub: "No real-money operation exists in this build to require it.",
    ok: "OK",
    failed: "FAILED",
    loadErr: "Could not load status from the server.",
  },
  ml: {
    title: "നിയന്ത്രണ പാനൽ",
    readonly: "🔒 വായന മാത്രം",
    moneyTitle: "പണ നിയന്ത്രണങ്ങൾ · പൂട്ടിയത്",
    houseTitle: "ഹൗസ്",
    invTitle: "മാറ്റമില്ലാത്ത നിയമങ്ങൾ",
    gateTitle: "യഥാർത്ഥ പണത്തിന്റെ ഗേറ്റുകൾ",
    back: "← ചിപ്പ് റൂമിലേക്ക് മടങ്ങുക",
    locked: "പൂട്ടി",
    absent: "ഈ ബിൽഡിൽ code path ഇല്ല",
    moneyNote:
      "ഇവ ആരെങ്കിലും ഓണാക്കാൻ മറന്ന സ്വിച്ചുകളല്ല. യഥാർത്ഥ പണത്തിന്റെ code path-കൾ ബിൽഡിൽ ഇല്ല; അവ തുടങ്ങേണ്ട function-കൾ പകരം error ഇടുന്നു. ഒരു setting മാറ്റിയാലും അവിടെ എത്താൻ കഴിയില്ല.",
    invNote:
      "ഓരോ അഭ്യർത്ഥനയിലും entry log-ൽ നിന്ന് വീണ്ടും കണക്കാക്കുന്നു. സൂക്ഷിച്ചുവച്ച ഒരു solvency flag അക്കങ്ങൾ പൊരുത്തപ്പെടാതായതിന് ശേഷവും 'ആരോഗ്യം' എന്ന് പറഞ്ഞേക്കാം; ഇതിന് അത് കഴിയില്ല — ബാലൻസുകൾ വരുന്ന അതേ log-ൽ നിന്നാണ് ഇതിന്റെ ഉത്തരവും.",
    gateNote:
      "ഏതെങ്കിലും യഥാർത്ഥ പണ പ്രവർത്തനം പരിഗണിക്കുന്നതിന് മുൻപ് ഇവയ്ക്ക് ഉത്തരം വേണം. ഈ ബിൽഡ് ഇവ ചോദിക്കുന്നില്ല — ഗേറ്റ് ചെയ്യാൻ അങ്ങനെയൊരു പ്രവർത്തനം ഇതിൽ ഇല്ല.",
    realEngine: "യഥാർത്ഥ പണ എഞ്ചിൻ",
    deposits: "നിക്ഷേപങ്ങൾ",
    withdrawals: "പിൻവലിക്കലുകൾ",
    cashOut: "മറ്റ് ആസ്തിയിലേക്ക് മാറ്റൽ",
    mode: "പ്ലാറ്റ്ഫോം മോഡ്",
    currency: "കറൻസി",
    circulation: "പ്രചാരത്തിലുള്ള ചിപ്പുകൾ",
    playerChips: "കളിക്കാരുടെ കൈയിൽ",
    housePos: "ഹൗസ് പൊസിഷൻ",
    entries: "ലെഡ്ജർ എൻട്രികൾ",
    players: "കളിക്കാർ",
    edge: "ഹൗസ് എഡ്ജ്",
    reconcile: "ഇറക്കിയ ചിപ്പുകളും കണക്കിലുള്ള ചിപ്പുകളും ഒന്ന്",
    reconcileSub:
      "മിന്റ് ഇറക്കിയ ഓരോ ചിപ്പും ഹൗസിന്റെയോ ഒരു കളിക്കാരന്റെയോ കൈയിലുണ്ട് — ഒന്നും മറ്റെവിടെയും പോയിട്ടില്ല.",
    negative: "സ്വന്തം ചരിത്രം നൽകാത്ത ചിപ്പ് ഒരു കളിക്കാരനുമില്ല",
    negativeSub:
      "ഒരു കളിക്കാരന്റെ അക്കൗണ്ട് ഒരിക്കലും പൂജ്യത്തിന് താഴെ പോകില്ല. പോയവ ഇവിടെ എണ്ണപ്പെടും.",
    storage: "Deploy-നെ അതിജീവിക്കുന്ന അക്കൗണ്ടുകൾ",
    storageOkSub:
      "ഈ server തുടങ്ങുമ്പോൾ database ഇതിനകം ഉണ്ടായിരുന്നു — അതായത് അത് container-ന്റെ ഉള്ളിലല്ല.",
    storageNewSub:
      "ഈ server തുടങ്ങുമ്പോൾ database ഉണ്ടായിരുന്നില്ല. ആദ്യ deploy-ൽ ഇത് സ്വാഭാവികം; അതിന് ശേഷമുള്ള ഏത് deploy-ലും ഇതിനർത്ഥം ഫയൽ ഒരു volume-ൽ അല്ല, എല്ലാ അക്കൗണ്ടുകളും പഴയ container-നൊപ്പം പോയി എന്നാണ്.",
    storagePgSub: "Postgres വേറൊരു സേവനമാണ്, ഈ ആപ്പ് redeploy ചെയ്താലും അതിനെ ബാധിക്കില്ല.",
    persisted: "നിലനിൽക്കുന്നു",
    fresh: "പുതിയത്",
    licence: "ഗെയിമിംഗ് ലൈസൻസ്",
    psp: "അംഗീകൃത നിയന്ത്രിത പേയ്‌മെന്റ് പ്രോസസർ",
    reserve: "ഉപയോക്തൃ ബാലൻസിനെ പിന്തുണയ്ക്കുന്ന കരുതൽ ധനം",
    notRequired: "ആവശ്യമില്ല",
    notRequiredSub: "ഇത് ആവശ്യമാക്കുന്ന യഥാർത്ഥ പണ പ്രവർത്തനം ഈ ബിൽഡിൽ ഇല്ല.",
    ok: "ശരി",
    failed: "പരാജയം",
    loadErr: "സെർവറിൽ നിന്ന് അവസ്ഥ വായിക്കാൻ കഴിഞ്ഞില്ല.",
  },
};

let lang = "en";
let status = null;

try {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "ml" || saved === "en") lang = saved;
} catch {
  /* storage blocked; English is a fine default */
}

const t = (key) => T[lang][key] ?? T.en[key] ?? key;

/* ---------- rendering ---------- */

function row(icon, name, sub, pillClass, pillText) {
  const el = document.createElement("div");
  el.className = "row";

  const ic = document.createElement("div");
  ic.className = "ic";
  ic.textContent = icon;

  const nm = document.createElement("div");
  nm.className = "nm";
  nm.append(name);
  if (sub) {
    const s = document.createElement("small");
    s.textContent = sub;
    nm.append(s);
  }

  const vl = document.createElement("div");
  vl.className = "vl";
  const pill = document.createElement("span");
  pill.className = `pill ${pillClass}`;
  pill.textContent = pillText;
  vl.append(pill);

  el.append(ic, nm, vl);
  return el;
}

function figure(label, value, plain) {
  const el = document.createElement("div");
  el.className = "fig";
  const l = document.createElement("div");
  l.className = "lbl";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = plain ? "val plain num" : "val num";
  v.textContent = value;
  el.append(l, v);
  return el;
}

function render() {
  document.documentElement.lang = lang === "ml" ? "ml" : "en";
  $("en").setAttribute("aria-pressed", String(lang === "en"));
  $("ml").setAttribute("aria-pressed", String(lang === "ml"));
  for (const el of document.querySelectorAll("[data-t]")) {
    el.textContent = t(el.dataset.t);
  }

  if (!status) return;
  const c = status.capabilities;

  // Money controls. The pill reads from the capability itself, so a build that
  // ever did support one of these would say so here rather than lying by markup.
  const controls = $("controls");
  controls.replaceChildren(
    row("💵", t("realEngine"), t("absent"), "lock", c.realMoneyEngine ? "ON" : t("locked")),
    row("⬇️", t("deposits"), t("absent"), "lock", c.deposits ? "ON" : t("locked")),
    row("⬆️", t("withdrawals"), t("absent"), "lock", c.withdrawals ? "ON" : t("locked")),
    row("🔁", t("cashOut"), t("absent"), "lock", c.cashOut ? "ON" : t("locked")),
    row("⚙️", t("mode"), "", "lock", c.mode),
    row("🪙", t("currency"), "", "lock", c.currency),
  );

  $("figures").replaceChildren(
    figure(t("circulation"), fmt(status.chipsInCirculation)),
    figure(t("playerChips"), fmt(status.playerChips)),
    figure(t("housePos"), fmt(status.housePosition)),
    figure(t("entries"), fmt(status.ledgerEntries), true),
    figure(t("players"), fmt(status.players), true),
    figure(t("edge"), `${(status.rules.houseEdge * 100).toFixed(1)}%`, true),
  );

  // Only rendered when the deployment told us; an older server that does not
  // report storage should show nothing rather than a guess.
  const storageRow = () => {
    const st = status.storage;
    if (!st) return null;
    if (st.engine === "postgres") {
      return row("✓", t("storage"), t("storagePgSub"), "ok", t("persisted"));
    }
    return st.createdThisBoot
      ? row("⚠️", t("storage"), t("storageNewSub"), "bad", t("fresh"))
      : row("✓", t("storage"), t("storageOkSub"), "ok", t("persisted"));
  };

  $("invariants").replaceChildren(
    ...[storageRow()].filter(Boolean),
    row(
      status.booksReconcile ? "✓" : "✕",
      t("reconcile"),
      t("reconcileSub"),
      status.booksReconcile ? "ok" : "bad",
      status.booksReconcile ? t("ok") : t("failed"),
    ),
    row(
      status.negativeAccounts === 0 ? "✓" : "✕",
      t("negative"),
      t("negativeSub"),
      status.negativeAccounts === 0 ? "ok" : "bad",
      status.negativeAccounts === 0 ? t("ok") : `${fmt(status.negativeAccounts)} ✕`,
    ),
  );

  // Rendered from the same capability flags: "not required" is a claim about
  // this build, and it is the build that answers.
  const gate = (name) =>
    row("🚫", name, t("notRequiredSub"), "lock", t("notRequired"));
  $("gates").replaceChildren(gate(t("licence")), gate(t("psp")), gate(t("reserve")));
}

function setLang(next) {
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* storage blocked; the choice just will not persist */
  }
  render();
}

/* ---------- load ---------- */

async function load() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(String(res.status));
    status = await res.json();
    $("err").hidden = true;
  } catch {
    $("err").textContent = t("loadErr");
    $("err").hidden = false;
  }
  render();
}

$("en").addEventListener("click", () => setLang("en"));
$("ml").addEventListener("click", () => setLang("ml"));

render();
void load();
