import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, MapPin, Minus, Plus, Lock, ChevronDown, Check, Trophy, BarChart3, Target } from "lucide-react";
import wc from "@/data/worldcup.json";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { listenPredictions, savePrediction, type Prediction } from "@/lib/predictions";

type Team = { name: string; name_en: string; flag: string; code: string };
type Stadium = { name: string; city: string };
type Match = {
  id: number;
  iso: string;
  date: string;
  time: string;
  matchday: number;
  stage: string;
  group: string | null;
  knockout: boolean;
  homeId: string | null;
  awayId: string | null;
  homeLabel: string;
  awayLabel: string;
  stadiumId: string;
};

const teams = wc.teams as Record<string, Team>;
const stadiums = wc.stadiums as Record<string, Stadium>;
const BRAZIL_ID = Object.keys(teams).find((id) => teams[id].name_en === "Brazil") ?? "all";
const matches = (wc.matches as Match[]).slice().sort((a, b) => a.iso.localeCompare(b.iso));

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} de ${MONTHS[m - 1]} de ${y}`;
};

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719";
const alias: Record<string, string> = {
  Czechia: "Czech Republic",
  Türkiye: "Turkey",
  "Congo DR": "Democratic Republic of the Congo",
  "Bosnia-Herzegovina": "Bosnia and Herzegovina",
  "IR Iran": "Iran",
};
const canon = (n: string) => alias[n] ?? n;

// Normaliza texto para comparação (sem acentos, só alfanumérico minúsculo).
const normStr = (s: string) =>
  (s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Mapa nome (em inglês) -> id do time, para resolver os jogos de mata-mata vindos da ESPN.
const nameToId: Record<string, string> = {};
for (const [id, t] of Object.entries(teams)) nameToId[normStr(t.name_en)] = id;
// Núcleo do nome do estádio (sem a palavra "stadium/estadio"), para casar sedes.
const venueCore = (s: string) => normStr((s ?? "").replace(/stadium|estadio/gi, ""));

type Score = { h: string; a: string; state: string; detail: string };
const STAR_KEY = "partidas-marcadas";

export function MatchesSection() {
  const [scores, setScores] = useState<Record<string, Score>>({});
  // Times reais do mata-mata resolvidos a partir da ESPN (id do jogo -> ids dos times).
  const [koTeams, setKoTeams] = useState<Record<number, { homeId: string; awayId: string }>>({});
  const [country, setCountry] = useState(BRAZIL_ID);
  const [phase, setPhase] = useState<"all" | "groups" | "knockout">("all");
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [onlyPredicted, setOnlyPredicted] = useState(false);
  const [starred, setStarred] = useState<Set<number>>(new Set());

  // palpites
  const { user, openAuth } = useAuth();
  const [preds, setPreds] = useState<Prediction[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, { h: number; a: number }>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => listenPredictions(setPreds), []);
  useEffect(() => {
    if (!user) setOnlyPredicted(false);
  }, [user]);

  // jogos marcados (localStorage)
  useEffect(() => {
    try {
      const s = localStorage.getItem(STAR_KEY);
      if (s) setStarred(new Set(JSON.parse(s) as number[]));
    } catch {
      /* ignora */
    }
  }, []);

  // placares ao vivo (ESPN)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(ESPN);
        const data = await res.json();
        const map: Record<string, Score> = {};
        // Eventos da ESPN com sede/data/times, usados para resolver o chaveamento do mata-mata.
        const evList: { venue: string; city: string; date: number; homeId?: string; awayId?: string }[] = [];
        for (const e of data.events ?? []) {
          const comp = e.competitions?.[0];
          const cs = comp?.competitors ?? [];
          const home = cs.find((c: any) => c.homeAway === "home");
          const away = cs.find((c: any) => c.homeAway === "away");
          if (!home || !away) continue;
          const st = e.status?.type ?? {};
          const sc: Score = { h: home.score, a: away.score, state: st.state, detail: st.shortDetail ?? "" };
          map[`${canon(home.team.displayName)}|${canon(away.team.displayName)}`] = sc;
          const venue = comp?.venue ?? {};
          evList.push({
            venue: venueCore(venue.fullName ?? ""),
            city: normStr(venue.address?.city ?? ""),
            date: Date.parse(e.date),
            homeId: nameToId[normStr(canon(home.team.displayName))],
            awayId: nameToId[normStr(canon(away.team.displayName))],
          });
        }

        // Resolve cada jogo de mata-mata casando por sede (ou cidade) + data (janela de 30h),
        // só quando os dois times já estão definidos na ESPN. Os ainda indefinidos seguem com rótulo.
        const ko: Record<number, { homeId: string; awayId: string }> = {};
        for (const m of matches) {
          if (!m.knockout) continue;
          const s = stadiums[m.stadiumId];
          if (!s) continue;
          const ourVenue = venueCore(s.name);
          const ourCity = normStr(s.city);
          const wcDate = Date.parse(m.iso.replace(" ", "T") + "Z");
          let best: { d: number; homeId?: string; awayId?: string } | null = null;
          for (const ev of evList) {
            const d = Math.abs(ev.date - wcDate);
            if (d > 30 * 3_600_000) continue;
            const venueMatch = !!ourVenue && !!ev.venue && (ev.venue.includes(ourVenue) || ourVenue.includes(ev.venue));
            const cityMatch = !!ev.city && (ourCity.includes(ev.city) || ev.city.includes(ourCity));
            if ((venueMatch || cityMatch) && (!best || d < best.d)) best = { d, homeId: ev.homeId, awayId: ev.awayId };
          }
          if (best?.homeId && best.awayId) ko[m.id] = { homeId: best.homeId, awayId: best.awayId };
        }
        if (alive) {
          setScores(map);
          setKoTeams(ko);
        }
      } catch {
        /* sem placares: mostra horário */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function toggleStar(id: number) {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(STAR_KEY, JSON.stringify([...next]));
      } catch {
        /* ignora */
      }
      return next;
    });
  }

  function scoreFor(m: Match): Score | null {
    if (!m.homeId || !m.awayId) return null;
    const h = teams[m.homeId].name_en;
    const a = teams[m.awayId].name_en;
    const direct = scores[`${h}|${a}`];
    if (direct) return direct;
    const rev = scores[`${a}|${h}`]; // ESPN com mando invertido: troca o placar
    if (rev) return { h: rev.a, a: rev.h, state: rev.state, detail: rev.detail };
    return null;
  }

  // ---- Palpites ----
  const kickoffMs = (m: Match) => new Date(m.iso.replace(" ", "T")).getTime();
  const canPredict = (m: Match) => !!m.homeId && !!m.awayId && now > 0 && now < kickoffMs(m) - 3_600_000;
  const myPred = (id: number) => (user ? preds.find((p) => p.matchId === id && p.uid === user.uid) : undefined);
  const draftOf = (m: Match) => {
    const d = drafts[m.id];
    if (d) return d;
    const mp = myPred(m.id);
    return mp ? { h: mp.h, a: mp.a } : { h: 0, a: 0 };
  };
  const setDraft = (id: number, h: number, a: number) => setDrafts((p) => ({ ...p, [id]: { h: Math.max(0, Math.min(20, h)), a: Math.max(0, Math.min(20, a)) } }));
  async function savePalpite(m: Match) {
    if (!user) {
      openAuth("signup");
      return;
    }
    const d = draftOf(m);
    setSavingId(m.id);
    try {
      await savePrediction({ matchId: m.id, uid: user.uid, name: user.name, h: d.h, a: d.a });
    } finally {
      setSavingId(null);
    }
  }
  function chartFor(id: number) {
    const map = new Map<string, number>();
    let total = 0;
    for (const p of preds)
      if (p.matchId === id) {
        const key = `${p.h}×${p.a}`;
        map.set(key, (map.get(key) ?? 0) + 1);
        total++;
      }
    const rows = [...map.entries()].map(([s, n]) => ({ s, n })).sort((a, b) => b.n - a.n);
    return { rows, total, max: rows[0]?.n ?? 1 };
  }

  // Partidas com os times do mata-mata já preenchidos (quando resolvidos pela ESPN).
  const resolvedMatches = useMemo(
    () => matches.map((m) => (m.knockout && koTeams[m.id] ? { ...m, homeId: koTeams[m.id].homeId, awayId: koTeams[m.id].awayId } : m)),
    [koTeams],
  );

  // Avisa (toast) quando um palpite SEU cravou o placar final de um jogo encerrado.
  useEffect(() => {
    if (!user) return;
    let seen: Set<string>;
    try {
      seen = new Set(JSON.parse(localStorage.getItem(`palpite-hits-${user.uid}`) || "[]") as string[]);
    } catch {
      seen = new Set();
    }
    const novos: string[] = [];
    for (const p of preds) {
      if (p.uid !== user.uid || seen.has(p.id)) continue;
      const m = resolvedMatches.find((x) => x.id === p.matchId);
      if (!m || !m.homeId || !m.awayId) continue;
      const res = scoreFor(m);
      if (!res || res.state !== "post") continue;
      if (`${p.h}×${p.a}` === `${res.h}×${res.a}`) {
        toast.success(`🎯 Cravou! ${teams[m.homeId].name} ${res.h}×${res.a} ${teams[m.awayId].name}`, { description: "Seu palpite bateu o placar final." });
        novos.push(p.id);
      }
    }
    if (novos.length) {
      novos.forEach((id) => seen.add(id));
      try {
        localStorage.setItem(`palpite-hits-${user.uid}`, JSON.stringify([...seen]));
      } catch {
        /* ignora */
      }
    }
  }, [preds, scores, user, resolvedMatches]);

  const filtered = useMemo(() => {
    return resolvedMatches.filter((m) => {
      if (phase === "groups" && m.knockout) return false;
      if (phase === "knockout" && !m.knockout) return false;
      if (country !== "all" && m.homeId !== country && m.awayId !== country) return false;
      if (onlyStarred && !starred.has(m.id)) return false;
      if (onlyPredicted && !myPred(m.id)) return false;
      return true;
    });
  }, [resolvedMatches, country, phase, onlyStarred, starred, onlyPredicted, preds, user]);

  // agrupa por data
  const byDate = useMemo(() => {
    const groups: { date: string; items: Match[] }[] = [];
    for (const m of filtered) {
      const last = groups[groups.length - 1];
      if (last && last.date === m.date) last.items.push(m);
      else groups.push({ date: m.date, items: [m] });
    }
    return groups;
  }, [filtered]);

  const countryOptions = Object.entries(teams)
    .map(([id, t]) => ({ id, name: t.name }))
    .sort((a, z) => a.name.localeCompare(z.name, "pt"));

  return (
    <section id="partidas" className="relative overflow-hidden bg-[#2F9645] py-14 text-white sm:py-24">
      <div className="relative mx-auto max-w-5xl px-4 sm:px-6">
        <div className="mb-8 text-center">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="font-display text-6xl text-[color:var(--fifa-yellow)] sm:text-7xl"
          >
            PARTIDAS
          </motion.h2>
          <p className="mt-2 text-sm text-white/80">Todos os 104 jogos da Copa de 2026 · placar ao vivo · marque os que quer assistir.</p>
        </div>

        {/* Controles */}
        <div className="mb-8 flex flex-wrap items-center justify-center gap-3">
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="rounded-full border border-white/20 bg-white px-4 py-2 text-sm font-semibold text-[color:var(--fifa-green-deep)] outline-none"
          >
            <option value="all">🌎 Todas as seleções</option>
            {countryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <div className="flex overflow-hidden rounded-full border border-white/20">
            {[
              { k: "all", l: "Todas" },
              { k: "groups", l: "Grupos" },
              { k: "knockout", l: "Mata-mata" },
            ].map((p) => (
              <button
                key={p.k}
                onClick={() => setPhase(p.k as typeof phase)}
                className={`px-4 py-2 text-sm font-semibold transition-colors ${phase === p.k ? "bg-white text-[color:var(--fifa-green-deep)]" : "text-white hover:bg-white/10"}`}
              >
                {p.l}
              </button>
            ))}
          </div>

          <button
            onClick={() => setOnlyStarred((v) => !v)}
            className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
              onlyStarred ? "border-[color:var(--fifa-yellow)] bg-[color:var(--fifa-yellow)] text-[color:var(--fifa-green-deep)]" : "border-white/20 text-white hover:bg-white/10"
            }`}
          >
            <Star className={`h-4 w-4 ${onlyStarred ? "fill-current" : ""}`} />
            Marcados
          </button>

          {user && (
            <button
              onClick={() => setOnlyPredicted((v) => !v)}
              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                onlyPredicted ? "border-[color:var(--fifa-yellow)] bg-[color:var(--fifa-yellow)] text-[color:var(--fifa-green-deep)]" : "border-white/20 text-white hover:bg-white/10"
              }`}
            >
              <Target className="h-4 w-4" />
              Palpitei
            </button>
          )}
        </div>

        {byDate.length === 0 ? (
          <p className="py-12 text-center text-white/80">Nenhum jogo com esses filtros.</p>
        ) : (
          <div className="space-y-7">
            {byDate.map((grp) => (
              <div key={grp.date}>
                <h3 className="mb-3 font-display text-xl tracking-wide text-[color:var(--fifa-yellow)]">{fmtDate(grp.date)}</h3>
                <div className="space-y-2.5">
                  {grp.items.map((m) => {
                    const raw = scoreFor(m);
                    // ESPN: "pre" = agendado, "in" = ao vivo, "post" = encerrado.
                    // Só trata como placar quando já começou (evita "0-0 encerrado" em jogo futuro).
                    const started = raw?.state === "in" || raw?.state === "post";
                    const sc = started ? raw : null;
                    const live = raw?.state === "in";
                    const finished = raw?.state === "post";
                    const home = m.homeId ? teams[m.homeId] : null;
                    const away = m.awayId ? teams[m.awayId] : null;
                    const starOn = starred.has(m.id);
                    const hasTeams = !!(home && away);
                    const open = openId === m.id;
                    const d = draftOf(m);
                    const mine = myPred(m.id);
                    const canP = canPredict(m);
                    const { rows, total, max } = chartFor(m.id);
                    const resultKey = finished && sc ? `${sc.h}×${sc.a}` : null;
                    return (
                      <div key={m.id} className="overflow-hidden rounded-2xl bg-white text-[color:var(--fifa-green-deep)] shadow-sm">
                        <div className={`flex items-center gap-3 p-3 sm:gap-4 sm:p-4 ${hasTeams ? "cursor-pointer" : ""}`} onClick={() => hasTeams && setOpenId(open ? null : m.id)}>
                          {/* casa */}
                          <div className="flex flex-1 items-center justify-end gap-2 text-right">
                            <span className="truncate font-display text-lg sm:text-xl">{home ? home.name : m.homeLabel}</span>
                            {home && <img src={home.flag} alt="" className="h-5 w-7 rounded-[2px] object-cover ring-1 ring-black/10" />}
                          </div>

                          {/* placar / horário */}
                          <div className="flex min-w-[64px] flex-col items-center">
                            {sc ? (
                              <span className="font-display text-2xl leading-none">
                                {sc.h}
                                <span className="mx-1 text-base">-</span>
                                {sc.a}
                              </span>
                            ) : (
                              <span className="font-display text-xl leading-none text-[color:var(--fifa-green)]">{m.time}</span>
                            )}
                            <span className={`mt-0.5 text-[9px] font-bold uppercase tracking-wider ${live ? "text-red-600" : "text-muted-foreground"}`}>
                              {live ? "● ao vivo" : finished ? "encerrado" : m.stage}
                            </span>
                          </div>

                          {/* fora */}
                          <div className="flex flex-1 items-center gap-2">
                            {away && <img src={away.flag} alt="" className="h-5 w-7 rounded-[2px] object-cover ring-1 ring-black/10" />}
                            <span className="truncate font-display text-lg sm:text-xl">{away ? away.name : m.awayLabel}</span>
                          </div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleStar(m.id);
                            }}
                            aria-label={starOn ? "Desmarcar jogo" : "Marcar jogo"}
                            className="shrink-0 text-[color:var(--fifa-green)] transition-transform hover:scale-110"
                          >
                            <Star className={`h-5 w-5 ${starOn ? "fill-[color:var(--fifa-yellow)] text-[color:var(--fifa-yellow)]" : ""}`} />
                          </button>
                          {hasTeams && <ChevronDown className={`h-5 w-5 shrink-0 text-[color:var(--fifa-green)]/60 transition-transform ${open ? "rotate-180" : ""}`} />}
                        </div>

                        <AnimatePresence initial={false}>
                          {open && hasTeams && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="border-t border-black/5 bg-[color:var(--fifa-green)]/[0.05]">
                              <div className="space-y-3.5 p-4">
                                {/* Resultado final */}
                                {resultKey && sc && (
                                  <div className="flex items-center justify-center gap-2 rounded-xl bg-[color:var(--fifa-green)] py-2 font-display text-lg tracking-wide text-white">
                                    <Trophy className="h-4 w-4 text-[color:var(--fifa-yellow)]" /> Resultado final · {sc.h}–{sc.a}
                                  </div>
                                )}

                                {/* Seu palpite */}
                                {canP ? (
                                  <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/[0.04]">
                                    <div className="mb-2.5 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--fifa-green)]">Crave o placar</div>
                                    <div className="flex items-center justify-center gap-3">
                                      <PalpiteStepper value={d.h} onChange={(v) => setDraft(m.id, v, d.a)} />
                                      <span className="font-display text-2xl text-black/25">×</span>
                                      <PalpiteStepper value={d.a} onChange={(v) => setDraft(m.id, d.h, v)} />
                                    </div>
                                    <button
                                      onClick={() => savePalpite(m)}
                                      disabled={savingId === m.id}
                                      className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-[color:var(--fifa-green)] py-2.5 text-sm font-bold text-white transition-all hover:bg-[color:var(--fifa-green-deep)] disabled:opacity-60"
                                    >
                                      {mine && savingId !== m.id ? <Check className="h-4 w-4" /> : null}
                                      {savingId === m.id ? "Salvando…" : !user ? "Entrar para palpitar" : mine ? `Atualizar palpite (${mine.h}×${mine.a})` : "Salvar meu palpite"}
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 rounded-xl bg-black/[0.04] py-2.5 text-sm font-medium text-muted-foreground">
                                    <Lock className="h-4 w-4" />
                                    {mine ? (
                                      <span>
                                        Você cravou <strong className="text-[color:var(--fifa-green-deep)]">{mine.h}×{mine.a}</strong>
                                        {resultKey && `${mine.h}×${mine.a}` === resultKey ? <span className="ml-1 font-bold text-[color:var(--fifa-green)]">· acertou em cheio! 🎯</span> : null}
                                      </span>
                                    ) : (
                                      "Palpites encerrados — fecham 1h antes do jogo"
                                    )}
                                  </div>
                                )}

                                {/* Gráfico de palpites */}
                                <div>
                                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                                    <BarChart3 className="h-3.5 w-3.5" /> Palpites da galera
                                    {total > 0 && <span className="rounded-full bg-[color:var(--fifa-green)]/12 px-1.5 text-[color:var(--fifa-green-deep)]">{total}</span>}
                                  </div>
                                  {total === 0 ? (
                                    <p className="rounded-xl bg-white/60 py-4 text-center text-sm text-muted-foreground ring-1 ring-black/[0.04]">
                                      {canP ? "Seja o primeiro a cravar o placar." : "Esse jogo não recebeu palpites."}
                                    </p>
                                  ) : (
                                    <div className="space-y-1.5">
                                      {rows.slice(0, 7).map((r) => {
                                        const isResult = r.s === resultKey;
                                        const isMine = !!mine && `${mine.h}×${mine.a}` === r.s;
                                        const pct = Math.round((r.n / total) * 100);
                                        return (
                                          <div key={r.s} className="flex items-center gap-2.5">
                                            <span className={`grid w-12 shrink-0 place-items-center rounded-md py-0.5 font-display text-base ${isResult ? "bg-[color:var(--fifa-green)] text-white" : "bg-black/[0.05] text-[color:var(--fifa-green-deep)]"}`}>{r.s}</span>
                                            <div className="relative h-6 flex-1 overflow-hidden rounded-lg bg-black/[0.04]">
                                              <div
                                                className={`h-full rounded-lg transition-all ${isResult ? "bg-[color:var(--fifa-green)]" : isMine ? "bg-[color:var(--fifa-green)]/65" : "bg-[color:var(--fifa-green)]/35"}`}
                                                style={{ width: `${Math.max(6, (r.n / max) * 100)}%` }}
                                              />
                                              <span className="absolute inset-y-0 right-2 flex items-center text-[11px] font-bold text-[color:var(--fifa-green-deep)]">{r.n} · {pct}%</span>
                                            </div>
                                            {isResult && <Trophy className="h-4 w-4 shrink-0 text-[color:var(--fifa-green)]" />}
                                          </div>
                                        );
                                      })}
                                      {rows.length > 7 && <p className="pt-0.5 text-center text-[11px] text-muted-foreground">+{rows.length - 7} outros placares</p>}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-xs text-white/70">
          <MapPin className="h-3.5 w-3.5" /> Sedes no Canadá, México e Estados Unidos · placares atualizados pela ESPN.
        </p>
      </div>
    </section>
  );
}

function PalpiteStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} aria-label="-1" className="grid h-8 w-8 place-items-center rounded-full bg-black/5 text-[color:var(--fifa-green-deep)] transition-colors hover:bg-black/10">
        <Minus className="h-4 w-4" />
      </button>
      <span className="w-7 text-center font-display text-2xl">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(20, value + 1))} aria-label="+1" className="grid h-8 w-8 place-items-center rounded-full bg-[color:var(--fifa-green)]/15 text-[color:var(--fifa-green-deep)] transition-colors hover:bg-[color:var(--fifa-green)]/25">
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
