const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const bank = require('./data/content-bank');
const extra = require('./data/extra-content');
const media = require('./data/media');
const bonus = require('./data/bonus-content');
const pixelPool = require('./data/pixel-pool');

const fmtCn = (() => {
  const s = String(bank.CODENAMES_WORDS.easy[0] || '');
  return s === s.toLocaleUpperCase('tr') ? w => w.toLocaleUpperCase('tr') : w => w;
})();
const haveCn = new Set(
  Object.values(bank.CODENAMES_WORDS).flat().map(w => String(w).toLocaleLowerCase('tr'))
);

const PORT = process.env.PORT || 3000;

const MIX_ALLOWED = new Set(['tf', 'closest', 'quiz', 'liar', 'wyr', 'ml', 'emoji', 'song', 'film', 'pixel']);
const MIX_FORBIDDEN = new Set(['codenames', 'werewolf', 'imposter']);
const ALL_GAMES = new Set([
  'tf', 'closest', 'quiz', 'liar', 'wyr', 'ml', 'emoji',
  'codenames', 'werewolf', 'imposter', 'song', 'film', 'pixel'
]);

const AV = ['🦊', '🐼', '🐸', '🦄', '🐙', '🐯', '🐵', '🦁', '🐨', '🐧'];
const TEAMS = [['Kırmızı', '#ef4444'], ['Mavi', '#3b82f6'], ['Yeşil', '#22c55e'], ['Turuncu', '#f59e0b']];
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const customCatalog = {
  music: [...bank.MUSIC_BANK.map(({ notes, ...m }) => m), ...extra.MUSIC],
  films: [...bank.FILM_BANK.map(({ scenes, ...f }) => f), ...extra.FILMS],
  imposter: [...bank.IMPOSTER_BANK],
  codenames: {
    easy: [...bank.CODENAMES_WORDS.easy],
    medium: [...bank.CODENAMES_WORDS.medium],
    hard: [...bank.CODENAMES_WORDS.hard],
  },
  artistsTr: [...new Set([...bank.TURKISH_ARTISTS, ...extra.ARTISTS_TR])],
  artistsEn: [...new Set([...bank.FOREIGN_ARTISTS, ...extra.ARTISTS_EN])],
  musicCategories: [...new Set(bank.MUSIC_CATEGORIES)],
  filmCategories: [...new Set(bank.FILM_CATEGORIES)],
  filmSeries: [...new Set(bank.FILM_SERIES)],
};

for (const k of Object.keys(bonus)) {
  if (k === 'CODENAMES_WORDS_EXTRA') {
    for (const w of bonus[k]) {
      const lw = String(w).toLocaleLowerCase('tr');
      if (!haveCn.has(lw)) {
        haveCn.add(lw);
        customCatalog.codenames.easy.push(fmtCn(w));
      }
    }
    continue;
  }
  if (k === 'IMPOSTER_BANK') {
    customCatalog.imposter.push(...bonus[k]);
    continue;
  }
  if (Array.isArray(bank[k])) {
    bank[k].push(...bonus[k]);
  }
}

const allCodenamesWords = () => [
  ...new Set([
    ...customCatalog.codenames.easy,
    ...customCatalog.codenames.medium,
    ...customCatalog.codenames.hard,
  ])
];

const newCode = () => {
  let c;
  do {
    c = Array.from({ length: 5 }, () => ABC[crypto.randomInt(ABC.length)]).join('');
  } while (rooms.has(c));
  return c;
};
const clean = (s, max = 12) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const norm = media.fold;
const shuffle = a => {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const clamp = (v, a, b, d) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d;
};

function itemKey(prefix, item) {
  if (item && item.id) return prefix + ':' + item.id;
  if (item && item.common && item.imposter) return prefix + ':' + item.common + '|' + item.imposter;
  const opts = item && Array.isArray(item.o) ? item.o.join('|') : '';
  return prefix + ':' + ((item && item.t) || '') + '|' + opts + '|' + ((item && item.x) || '');
}

function pickNonRepeating(pool, prefix, usedSet, lastMap, excludeKeys) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const keyOf = item => itemKey(prefix, item);
  const blocked = excludeKeys || new Set();
  const lastKey = lastMap ? lastMap.get(prefix) : null;

  let fresh = pool.filter(item => {
    const k = keyOf(item);
    return !usedSet.has(k) && !blocked.has(k);
  });

  if (!fresh.length) {
    for (const item of pool) usedSet.delete(keyOf(item));
    fresh = pool.filter(item => {
      const k = keyOf(item);
      return !blocked.has(k) && (pool.length <= 1 || k !== lastKey);
    });
    if (!fresh.length) fresh = pool.filter(item => !blocked.has(keyOf(item)));
    if (!fresh.length) fresh = pool;
  }

  const chosen = fresh[crypto.randomInt(fresh.length)];
  const k = keyOf(chosen);
  usedSet.add(k);
  if (lastMap) lastMap.set(prefix, k);
  return chosen;
}

const akey = (r, p) => (r.game === 'closest' && r.mode === 'team' ? 't' + p.team : p.id);
const activePlayers = r => [...r.players.values()].filter(p => p.on);
const allDone = r => {
  const act = activePlayers(r);
  if (!act.length) return false;
  if (r.game === 'codenames' && r.cn) return false;
  return act.every(p => r.ans.has(akey(r, p)));
};
const me = s => {
  const r = rooms.get(s.data.code);
  const p = r && r.players.get(s.data.id);
  return p ? [r, p] : [];
};

function sanitizeMusicFilter(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const cats = Array.isArray(f.categories) ? f.categories.map(x => String(x)).slice(0, 12) : [];
  const artists = Array.isArray(f.artists) ? f.artists.map(x => String(x)).slice(0, 25) : [];
  const lang = ['all', 'tr', 'en'].includes(f.lang) ? f.lang : 'all';
  const minYear = f.minYear ? clamp(f.minYear, 1950, 2026, 1950) : null;
  const maxYear = f.maxYear ? clamp(f.maxYear, 1950, 2026, 2026) : null;
  const onlyPopular = Boolean(f.onlyPopular);
  const randomMix = Boolean(f.randomMix);
  return { categories: cats, artists, lang, minYear, maxYear, onlyPopular, randomMix };
}

function getFilteredMusic(r) {
  const mf = sanitizeMusicFilter(r.cfg && r.cfg.musicFilter);
  const pool = customCatalog.music.filter(m => {
    if (mf.lang === 'tr' && m.lang !== 'tr') return false;
    if (mf.lang === 'en' && m.lang !== 'en') return false;
    if (mf.onlyPopular && m.pop !== 'high') return false;
    if (mf.minYear && m.year < mf.minYear) return false;
    if (mf.maxYear && m.year > mf.maxYear) return false;
    if (!mf.randomMix && mf.categories.length && !mf.categories.includes('Karışık')) {
      if (!m.genres.some(g => mf.categories.includes(g))) return false;
    }
    if (!mf.randomMix && mf.artists.length && !mf.artists.includes(m.artist)) return false;
    return true;
  });
  return pool.length ? pool : [...customCatalog.music];
}

function sanitizeFilmFilter(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const categories = Array.isArray(f.categories) ? f.categories.map(x => String(x)).slice(0, 15) : [];
  const series = Array.isArray(f.series) ? f.series.map(x => String(x)).slice(0, 15) : [];
  const region = ['all', 'tr', 'hollywood'].includes(f.region) ? f.region : 'all';
  const minYear = f.minYear ? clamp(f.minYear, 1920, 2026, 1920) : null;
  const maxYear = f.maxYear ? clamp(f.maxYear, 1920, 2026, 2026) : null;
  const popLevel = ['all', 'high', 'medium'].includes(f.popLevel) ? f.popLevel : 'all';
  const randomMix = Boolean(f.randomMix);
  return { categories, series, region, minYear, maxYear, popLevel, randomMix };
}

function getFilteredFilms(r) {
  const ff = sanitizeFilmFilter(r.cfg && r.cfg.filmFilter);
  const pool = customCatalog.films.filter(item => {
    if (ff.region === 'tr' && item.region !== 'tr') return false;
    if (ff.region === 'hollywood' && item.region !== 'hollywood') return false;
    if (ff.popLevel !== 'all' && item.pop !== ff.popLevel) return false;
    if (ff.minYear && item.year < ff.minYear) return false;
    if (ff.maxYear && item.year > ff.maxYear) return false;
    if (!ff.randomMix && ff.categories.length && !ff.categories.some(c => ff.categories.includes(c))) return false;
    if (!ff.randomMix && ff.series.length && (!item.series || !ff.series.includes(item.series))) return false;
    return true;
  });
  return pool.length ? pool : [...customCatalog.films];
}

function getActiveGameId(r) {
  if (r.mix && r.mix.active) {
    return r.mix.games[r.mix.step % r.mix.games.length];
  }
  return r.game;
}

function givePoints(r, p, pts) {
  if (!p || !pts) return;
  if (r.mode === 'team' && p.team != null && r.teams[p.team]) {
    r.teams[p.team].score += pts;
  } else {
    p.score += pts;
  }
}

function initCodenames(r) {
  const ps = [...r.players.values()];
  r.mode = 'team';
  r.teams = [
    { name: 'Kırmızı', color: '#ef4444', score: 0 },
    { name: 'Mavi', color: '#3b82f6', score: 0 }
  ];
  const shuffledPlayers = shuffle(ps);
  shuffledPlayers.forEach((p, i) => {
    p.team = i % 2;
    p.spymaster = false;
  });
  const redSpies = shuffledPlayers.filter(p => p.team === 0);
  const blueSpies = shuffledPlayers.filter(p => p.team === 1);
  if (redSpies[0]) redSpies[0].spymaster = true;
  if (blueSpies[0]) blueSpies[0].spymaster = true;

  const allW = shuffle(allCodenamesWords());
  const fresh = allW.filter(w => !r.usedKeys.has('cn:' + w));
  const chosenWords = [...fresh, ...allW.filter(w => r.usedKeys.has('cn:' + w))].slice(0, 25);
  chosenWords.forEach(w => r.usedKeys.add('cn:' + w));

  const firstTeam = crypto.randomInt(2);
  const secondTeam = firstTeam === 0 ? 1 : 0;
  const types = [
    ...Array(9).fill(firstTeam === 0 ? 'red' : 'blue'),
    ...Array(8).fill(secondTeam === 0 ? 'red' : 'blue'),
    ...Array(7).fill('neutral'),
    'assassin'
  ];
  const keyMap = shuffle(types);
  const redTotal = keyMap.filter(t => t === 'red').length;
  const blueTotal = keyMap.filter(t => t === 'blue').length;

  r.cn = {
    cards: chosenWords.map((word, idx) => ({
      idx,
      word,
      type: keyMap[idx],
      revealed: false,
      byTeam: null
    })),
    turnTeam: firstTeam,
    clue: null,
    guessesLeft: 0,
    redLeft: redTotal,
    blueLeft: blueTotal,
    winnerTeam: null,
    reason: '',
    log: [`Oyun başladı! İlk sıra ${firstTeam === 0 ? 'Kırmızı' : 'Mavi'} takımda.`]
  };
  r.phase = 'question';
  r.round = 1;
}

function initWerewolf(r) {
  const ps = [...r.players.values()];
  const count = ps.length;
  const wolfCount = count >= 8 ? 3 : count >= 5 ? 2 : 1;
  const rolePool = ['doctor', 'detective'];
  for (let i = 0; i < wolfCount; i++) rolePool.push('werewolf');
  while (rolePool.length < count) rolePool.push('villager');

  const assigned = shuffle(rolePool);
  ps.forEach((p, idx) => {
    p.role = assigned[idx];
    p.alive = true;
    p.score = 0;
  });

  r.ww = {
    dayNum: 1,
    subPhase: 'night',
    nightActions: { wolfTarget: null, doctorSave: null, detectiveCheck: null },
    votes: new Map(),
    lastNightSummary: '',
    lastVoteSummary: '',
    winner: null,
    history: [`1. Gece başladı. Roller gizlice dağıtıldı (${wolfCount} Vampir, 1 Doktor, 1 Dedektif).`],
    durations: {
      night: clamp(r.cfg.wwNight, 10, 90, clamp(r.cfg.time, 10, 60, 25)),
      day: clamp(r.cfg.wwDay, 15, 180, 45),
      vote: clamp(r.cfg.wwVote, 10, 120, 25),
    }
  };
  r.phase = 'question';
  r.round = 1;
  r.deadline = Date.now() + r.ww.durations.night * 1000;
  r.timer = setTimeout(() => resolveWerewolfNight(r), r.ww.durations.night * 1000);
}

function checkWerewolfWin(r) {
  const alive = [...r.players.values()].filter(p => p.alive);
  const wolves = alive.filter(p => p.role === 'werewolf');
  const others = alive.filter(p => p.role !== 'werewolf');
  if (wolves.length === 0) {
    r.ww.winner = 'villagers';
    r.ww.subPhase = 'ended';
    r.ww.history.push('Tüm vampirler elendi! Köylüler kazandı.');
    for (const p of r.players.values()) {
      if (p.role !== 'werewolf') p.score += 150;
    }
    finish(r);
    return true;
  }
  if (wolves.length >= others.length) {
    r.ww.winner = 'werewolves';
    r.ww.subPhase = 'ended';
    r.ww.history.push('Vampirler sayısal üstünlüğü ele geçirdi! Vampirler kazandı.');
    for (const p of r.players.values()) {
      if (p.role === 'werewolf') p.score += 150;
    }
    finish(r);
    return true;
  }
  return false;
}

function resolveWerewolfNight(r) {
  if (!r.ww || r.phase !== 'question' || r.ww.subPhase !== 'night') return;
  clearTimeout(r.timer);
  const na = r.ww.nightActions;
  const target = na.wolfTarget ? r.players.get(na.wolfTarget) : null;
  const saved = na.doctorSave && na.doctorSave === na.wolfTarget;

  let summary = '';
  if (target && target.alive && !saved) {
    target.alive = false;
    summary = `Gece ${target.name} (${target.av}) vampirler tarafından oyun dışı bırakıldı.`;
  } else if (target && saved) {
    summary = `Gece bir saldırı gerçekleşti ancak Doktor müdahalesiyle kurtarıldı!`;
  } else {
    summary = `Gece sessiz geçti, kimse oyun dışı kalmadı.`;
  }
  r.ww.lastNightSummary = summary;
  r.ww.history.push(`${r.ww.dayNum}. Gece Sonucu: ${summary}`);
  r.ww.nightActions = { wolfTarget: null, doctorSave: null, detectiveCheck: null };

  if (checkWerewolfWin(r)) return;

  r.ww.subPhase = 'day_discuss';
  r.deadline = Date.now() + r.ww.durations.day * 1000;
  push(r);
  r.timer = setTimeout(() => startWerewolfVote(r), r.ww.durations.day * 1000);
}

function startWerewolfVote(r) {
  if (!r.ww || r.phase !== 'question' || r.ww.subPhase === 'ended') return;
  clearTimeout(r.timer);
  r.ww.subPhase = 'day_vote';
  r.ww.votes = new Map();
  r.ww.history.push(`${r.ww.dayNum}. Gün oylaması başladı.`);
  r.deadline = Date.now() + r.ww.durations.vote * 1000;
  push(r);
  r.timer = setTimeout(() => resolveWerewolfVote(r), r.ww.durations.vote * 1000);
}

function resolveWerewolfVote(r) {
  if (!r.ww || r.phase !== 'question' || r.ww.subPhase !== 'day_vote') return;
  clearTimeout(r.timer);
  const counts = new Map();
  for (const [, tid] of r.ww.votes) {
    if (!tid) continue;
    counts.set(tid, (counts.get(tid) || 0) + 1);
  }
  let topVotes = 0;
  let topIds = [];
  for (const [tid, c] of counts) {
    if (c > topVotes) {
      topVotes = c;
      topIds = [tid];
    } else if (c === topVotes) {
      topIds.push(tid);
    }
  }

  let vSummary = '';
  if (topIds.length === 1 && topVotes > 0) {
    const eliminated = r.players.get(topIds[0]);
    if (eliminated && eliminated.alive) {
      eliminated.alive = false;
      vSummary = `Oylama sonucu ${eliminated.name} (${eliminated.av}) ${topVotes} oyla elendi!`;
    }
  } else if (topIds.length > 1 && topVotes > 0) {
    vSummary = `Oylamada eşitlik (${topVotes} oy) çıktı; kimse elenmedi.`;
  } else {
    vSummary = `Oylama yapılmadı veya geçerli oy çıkmadı; kimse elenmedi.`;
  }

  r.ww.lastVoteSummary = vSummary;
  r.ww.history.push(`${r.ww.dayNum}. Gün Oylaması: ${vSummary}`);

  if (checkWerewolfWin(r)) return;

  r.ww.dayNum++;
  r.ww.subPhase = 'night';
  r.ww.history.push(`${r.ww.dayNum}. Gece başladı.`);
  r.deadline = Date.now() + r.ww.durations.night * 1000;
  push(r);
  r.timer = setTimeout(() => resolveWerewolfNight(r), r.ww.durations.night * 1000);
}

function initImposter(r) {
  const ps = [...r.players.values()];
  const impCount = clamp(r.cfg.imposterCount, 1, Math.max(1, Math.floor((ps.length - 1) / 2)), 1);

  const pick = pickNonRepeating(customCatalog.imposter, 'imp', r.usedKeys, r.lastKeys);
  const shuffledIds = shuffle(ps.map(p => p.id));
  const impSet = new Set(shuffledIds.slice(0, impCount));

  ps.forEach(p => {
    p.isImposter = impSet.has(p.id);
    p.secretWord = p.isImposter ? pick.imposter : pick.common;
  });

  const sec = clamp(r.cfg.time, 10, 60, 30);
  r.imp = {
    category: pick.c,
    commonWord: pick.common,
    imposterWord: pick.imposter,
    impCount,
    clues: [],
    votes: new Map(),
    subPhase: 'clues',
    guessAttempted: false,
    winnerSide: null,
  };
  r.phase = 'question';
  r.round = 1;
  r.deadline = Date.now() + sec * 1000;
  r.timer = setTimeout(() => {
    if (r.imp && r.phase === 'question') {
      r.imp.subPhase = 'vote';
      r.deadline = Date.now() + Math.max(15, Math.round(sec * 0.7)) * 1000;
      push(r);
      r.timer = setTimeout(() => resolveImposterVote(r), Math.max(15, Math.round(sec * 0.7)) * 1000);
    }
  }, sec * 1000);
}

function resolveImposterVote(r) {
  if (!r.imp || r.phase !== 'question') return;
  clearTimeout(r.timer);
  for (const vid of [...r.imp.votes.keys()]) {
    if (!r.players.has(vid)) r.imp.votes.delete(vid);
  }
  const tally = new Map();
  for (const [, tid] of r.imp.votes) {
    if (!tid || !r.players.has(tid)) continue;
    tally.set(tid, (tally.get(tid) || 0) + 1);
  }
  let maxV = 0;
  let topIds = [];
  for (const [tid, c] of tally) {
    if (c > maxV) {
      maxV = c;
      topIds = [tid];
    } else if (c === maxV) {
      topIds.push(tid);
    }
  }
  const caught = topIds.length === 1 && maxV > 0 && r.players.get(topIds[0]) && r.players.get(topIds[0]).isImposter;
  if (caught) {
    if (r.cfg.imposterGuessBonus && !r.imp.guessAttempted) {
      r.imp.subPhase = 'guess_common';
      r.imp.caughtTargetId = topIds[0];
      r.deadline = Date.now() + 15000;
      push(r);
      r.timer = setTimeout(() => finalizeImposterResult(r, false), 15000);
      return;
    }
    finalizeImposterResult(r, true);
  } else {
    finalizeImposterResult(r, false);
  }
}

function finalizeImposterResult(r, crewWon) {
  if (!r.imp) return;
  clearTimeout(r.timer);
  r.imp.winnerSide = crewWon ? 'crew' : 'imposter';
  const rows = [];
  for (const p of r.players.values()) {
    const pts = crewWon ? (!p.isImposter ? 120 : 0) : (p.isImposter ? 150 : 0);
    p.score += pts;
    rows.push({
      n: p.name,
      av: p.av,
      v: (p.isImposter ? '🕵️ Imposter (' : '✅ Ortak (') + (p.secretWord || '') + ')',
      pts
    });
  }
  rows.sort((a, b) => b.pts - a.pts);
  r.rev = {
    v: `Ortak Kelime: ${r.imp.commonWord} · Imposter Kelimesi: ${r.imp.imposterWord}`,
    x: crewWon ? 'Normal oyuncular Imposter’ı yakaladı!' : 'Imposter izini kaybettirdi ve kazandı!',
    rows
  };
  r.phase = 'reveal';
  push(r);
  r.timer = setTimeout(() => finish(r), 7000);
}

const QCAT_BANK = { tf: 'TF_BANK', closest: 'CLOSEST_BANK', quiz: 'QUIZ_BANK', liar: 'LIAR_BANK', wyr: 'WYR_BANK', ml: 'ML_BANK', emoji: 'EMOJI_BANK' };
const gameCats = g => (g === 'pixel' ? pixelPool : bank[QCAT_BANK[g]] || []).map(x => x.c);
function sanitizeCats(arr, game) {
  if (!Array.isArray(arr)) return [];
  const ok = new Set(gameCats(game));
  return [...new Set(arr)].filter(x => typeof x === 'string' && ok.has(x)).slice(0, 20);
}
function byCat(pool, r) {
  const c = (r.cfg && r.cfg.cats) || [];
  const f = c.length ? pool.filter(i => c.includes(i.c)) : pool;
  return f.length ? f : pool;
}
function getPixelPool(r) {
  const c = (r.cfg && r.cfg.cats) || [];
  const base = pixelPool.filter(x => !c.length || c.includes(x.c));
  return base.length ? base : pixelPool;
}

function startRound(r) {
  clearTimeout(r.timer);
  const gameId = getActiveGameId(r);
  r.game = gameId;

  if (gameId === 'codenames') {
    initCodenames(r);
    push(r);
    return;
  }
  if (gameId === 'werewolf') {
    initWerewolf(r);
    push(r);
    return;
  }
  if (gameId === 'imposter') {
    initImposter(r);
    push(r);
    return;
  }

  r.round++;
  const sec = clamp(r.cfg.time, 10, 60, 20);

  r.ans = new Map();
  r.phase = 'question';
  r.deadline = Date.now() + sec * 1000;
  r.activeSec = sec;

  if (gameId === 'tf') {
    const item = pickNonRepeating(byCat(bank.TF_BANK, r), 'tf', r.usedKeys, r.lastKeys);
    r.q = { t: item.t, o: ['Doğru', 'Yanlış'], v: item.v ? 0 : 1, x: item.x, c: item.c, u: '' };
  } else if (gameId === 'closest') {
    const item = pickNonRepeating(byCat(bank.CLOSEST_BANK, r), 'cl', r.usedKeys, r.lastKeys);
    r.q = { t: item.t, v: item.v, u: item.u || '', x: item.x, c: item.c };
  } else if (gameId === 'quiz') {
    const item = pickNonRepeating(byCat(bank.QUIZ_BANK, r), 'qz', r.usedKeys, r.lastKeys);
    r.q = { t: item.t, o: item.o, v: item.v, x: item.x, c: item.c, u: '' };
  } else if (gameId === 'liar') {
    const item = pickNonRepeating(byCat(bank.LIAR_BANK, r), 'lr', r.usedKeys, r.lastKeys);
    r.q = { t: item.t, o: item.o, v: item.v, x: item.x, c: item.c, u: '' };
  } else if (gameId === 'wyr') {
    const item = pickNonRepeating(byCat(bank.WYR_BANK, r), 'wr', r.usedKeys, r.lastKeys);
    r.q = { t: item.t, o: item.o, v: null, x: item.x, c: item.c, u: '' };
  } else if (gameId === 'ml') {
    const item = pickNonRepeating(byCat(bank.ML_BANK, r), 'ml', r.usedKeys, r.lastKeys);
    const opts = [...r.players.values()].map(p => `${p.av} ${p.name}`);
    r.q = { t: item.t, o: opts.length ? opts : ['Oyuncu 1', 'Oyuncu 2'], v: null, x: item.x, c: item.c, u: '' };
  } else if (gameId === 'emoji') {
    const item = pickNonRepeating(byCat(bank.EMOJI_BANK, r), 'em', r.usedKeys, r.lastKeys);
    r.q = { t: item.t, v: item.x, a: item.a, x: `Cevap: ${item.x}`, c: item.c, u: '' };
  } else if (gameId === 'song' || gameId === 'film' || gameId === 'pixel') {
    return startMediaRound(r, gameId, sec);
  }

  r.timer = setTimeout(() => reveal(r), sec * 1000 + 400);
  push(r);
}

const FRAME_PTS = [100, 80, 60, 40, 20];

async function startMediaRound(r, gameId, sec) {
  const round = r.round;
  const token = (r.mtoken = (r.mtoken || 0) + 1);
  r.penaltyUntil = new Map();
  r.q = { loading: true, t: gameId === 'song' ? '⏳ Şarkı hazırlanıyor…' : '⏳ Sahne hazırlanıyor…', c: '', u: '' };
  r.deadline = Date.now() + 60000;
  push(r);
  const alive = () => r.phase === 'question' && r.round === round && r.mtoken === token;
  const pool = gameId === 'song' ? getFilteredMusic(r) : gameId === 'pixel' ? getPixelPool(r) : getFilteredFilms(r);
  const prefix = gameId === 'song' ? 'sg' : gameId === 'pixel' ? 'px' : 'fm';
  const triedInAttempt = new Set();
  let q = null;
  for (let i = 0; i < 6 && !q; i++) {
    const item = pickNonRepeating(pool, prefix, r.usedKeys, r.lastKeys, triedInAttempt);
    if (!item) break;
    const k = itemKey(prefix, item);
    triedInAttempt.add(k);
    let res = null;
    try {
      res = gameId === 'song' ? await media.resolveSong(item)
        : gameId === 'pixel' ? await media.resolvePixel(item)
        : await media.resolveFilm(item);
    } catch (e) { res = null; }
    if (!alive()) return;
    if (!res) {
      r.usedKeys.delete(k);
      continue;
    }
    if (gameId === 'song') {
      const clipSec = Math.min(sec, 28);
      q = {
        t: '🎵 Şarkıyı dinle ve tahmin et!', c: item.genres[0] || 'Müzik', u: '',
        songId: item.id, artist: item.artist, title: item.title, audio: res, clipSec,
        seek: crypto.randomInt(Math.max(1, 29 - clipSec)), playAt: Date.now() + 3000
      };
    } else if (gameId === 'pixel') {
      const stepMs = Math.max(3000, Math.floor((sec * 1000) / 5));
      q = {
        t: '🧩 Pikseller açıldıkça kim olduğunu bul!', c: item.c, u: '',
        filmId: item.id, title: item.name, year: '', answers: item.ans,
        scenes: [10, 18, 30, 54, 0].map((cells, k) => ({ label: 'Seviye ' + (k + 1), img: res[k], cells })),
        sceneIndex: 0, stepMs, nextAt: Date.now() + 3000 + stepMs
      };
    } else {
      const stepMs = Math.max(3000, Math.floor((sec * 1000) / res.length));
      q = {
        t: '🎬 Kareye bak ve filmi tahmin et!', c: item.categories[0] || 'Sinema', u: '',
        filmId: item.id, title: item.title, year: item.year, answers: item.answers || [item.title],
        scenes: res.map((img, k) => ({ label: 'Kare ' + (k + 1), img })), sceneIndex: 0, stepMs, nextAt: Date.now() + 3000 + stepMs
      };
    }
  }
  if (!q) {
    r.q = { t: '⚠️ Medya kaynağı bulunamadı, tur atlanıyor', c: '', u: '', title: 'Kaynak bulunamadı', artist: '-', year: '-', scenes: [], sceneIndex: 0, answers: [] };
    push(r);
    r.timer = setTimeout(() => reveal(r), 2000);
    return;
  }
  const lead = 3000;
  r.q = q;
  r.activeSec = sec;
  r.deadline = Date.now() + lead + sec * 1000;
  if (gameId === 'film' || gameId === 'pixel') {
    clearTimeout(r.sceneTimer);
    r.sceneTimer = setTimeout(function step() {
      if (!alive() || !r.q.scenes) return;
      if (r.q.sceneIndex < r.q.scenes.length - 1) {
        r.q.sceneIndex++;
        r.q.nextAt = r.q.sceneIndex < r.q.scenes.length - 1 ? Date.now() + r.q.stepMs : 0;
        push(r);
        if (r.q.nextAt) r.sceneTimer = setTimeout(step, r.q.stepMs);
      }
    }, lead + q.stepMs);
  }
  r.timer = setTimeout(() => reveal(r), lead + sec * 1000 + 400);
  push(r);
}

function reveal(r) {
  if (r.phase !== 'question') return;
  clearTimeout(r.timer);
  clearTimeout(r.sceneTimer);

  const g = r.game;
  const q = r.q || {};
  let rows = [];
  let cnt = null;
  let revVal = q.v != null ? q.v : null;
  let revExtra = q.x || '';

  if (g === 'tf' || g === 'quiz' || g === 'liar') {
    cnt = Array((q.o || []).length).fill(0);
    for (const [pid, a] of r.ans) {
      const p = r.players.get(pid);
      if (!p) continue;
      if (typeof a.v === 'number' && cnt[a.v] != null) cnt[a.v]++;
      const ok = a.v === q.v;
      const ratio = Math.max(0, (r.deadline - a.t) / ((r.activeSec || 20) * 1000));
      const pts = ok ? 100 + Math.round(100 * ratio) : 0;
      givePoints(r, p, pts);
      rows.push({ n: p.name, av: p.av, c: r.mode === 'team' && p.team != null ? r.teams[p.team].color : null, v: a.v, pts });
    }
  } else if (g === 'wyr' || g === 'ml') {
    cnt = Array((q.o || []).length).fill(0);
    for (const [, a] of r.ans) {
      if (typeof a.v === 'number' && cnt[a.v] != null) cnt[a.v]++;
    }
    let maxC = 0;
    for (const c of cnt) if (c > maxC) maxC = c;
    const majSet = new Set();
    cnt.forEach((c, idx) => { if (maxC > 0 && c === maxC) majSet.add(idx); });
    for (const [pid, a] of r.ans) {
      const p = r.players.get(pid);
      if (!p) continue;
      const pts = majSet.has(a.v) ? 100 : 25;
      givePoints(r, p, pts);
      rows.push({ n: p.name, av: p.av, c: r.mode === 'team' && p.team != null ? r.teams[p.team].color : null, v: a.v, pts });
    }
    revVal = null;
  } else if (g === 'closest') {
    const v = q.v;
    const L = [...r.ans].map(([k, a]) => ({ k, a, d: Math.abs(a.v - v) })).sort((x, y) => x.d - y.d);
    const ds = [...new Set(L.map(x => x.d))];
    rows = L.map(x => {
      const rk = ds.indexOf(x.d);
      const pts = rk === 0 ? 100 : rk === 1 ? 50 : 0;
      if (x.k[0] === 't') {
        const tm = r.teams[+x.k.slice(1)];
        if (tm) tm.score += pts;
        return { n: tm ? tm.name : 'Takım', av: '🏳️', c: tm ? tm.color : null, v: x.a.v, pts };
      }
      const p = r.players.get(x.k);
      if (!p) return null;
      p.score += pts;
      return { n: p.name, av: p.av, v: x.a.v, pts };
    }).filter(Boolean);
  } else if (g === 'emoji' || g === 'song' || g === 'film' || g === 'pixel') {
    const corr = [...r.ans.entries()]
      .filter(([, a]) => a.ok)
      .sort((a, b) => a[1].t - b[1].t);
    const rankPts = [100, 70, 50];
    corr.forEach(([pid, a], idx) => {
      const p = r.players.get(pid);
      if (!p) return;
      const pts = (g === 'film' || g === 'pixel') ? (FRAME_PTS[a.fi] != null ? FRAME_PTS[a.fi] : 20) : (rankPts[idx] != null ? rankPts[idx] : 25);
      givePoints(r, p, pts);
      rows.push({ n: p.name, av: p.av, c: r.mode === 'team' && p.team != null ? r.teams[p.team].color : null, v: a.v, pts });
    });
    for (const [pid, a] of r.ans) {
      if (!a.ok) {
        const p = r.players.get(pid);
        if (p) rows.push({ n: p.name, av: p.av, c: null, v: a.v, pts: 0 });
      }
    }
    if (g === 'song') {
      revVal = `${q.title} — ${q.artist}`;
      revExtra = `Tür: ${q.c}`;
    } else if (g === 'pixel') {
      revVal = q.title;
      revExtra = `Açılan seviye: ${q.sceneIndex + 1}/${q.scenes.length}`;
    } else if (g === 'film') {
      revVal = `${q.title} (${q.year})`;
      revExtra = `Açılan kare: ${q.sceneIndex + 1}/${q.scenes.length}`;
    }
  }

  rows.sort((a, b) => b.pts - a.pts);
  r.rev = { v: revVal, cnt, x: revExtra, rows };
  r.phase = 'reveal';

  let nextAction = () => finish(r);
  if (r.mix && r.mix.active) {
    const perGame = r.mix.roundsPerGame || 2;
    const totalSteps = r.mix.games.length * perGame;
    r.mix.completedRounds++;
    if (r.mix.completedRounds >= totalSteps) {
      nextAction = () => finish(r);
    } else {
      r.mix.step = Math.floor(r.mix.completedRounds / perGame) % r.mix.games.length;
      nextAction = () => startRound(r);
    }
  } else {
    nextAction = () => (r.cfg.rounds && r.round >= r.cfg.rounds ? finish(r) : startRound(r));
  }

  push(r);
  r.timer = setTimeout(nextAction, 6500);
}

function finish(r) {
  if (r.phase === 'end') return;
  clearTimeout(r.timer);
  clearTimeout(r.sceneTimer);
  r.phase = 'end';
  for (const p of r.players.values()) {
    const gamePts = r.mode === 'team' && p.team != null && r.teams[p.team] ? r.teams[p.team].score : p.score;
    p.night += gamePts;
  }
  push(r);
}

function toLobby(r) {
  clearTimeout(r.timer);
  clearTimeout(r.sceneTimer);
  r.phase = 'lobby';
  r.round = 0;
  r.cn = null;
  r.ww = null;
  r.imp = null;
  r.mix = null;
  r.q = null;
  r.rev = null;
  r.teams = [];
  r.mode = 'solo';
  for (const p of r.players.values()) {
    p.score = 0;
    p.team = null;
    p.spymaster = false;
    p.role = null;
    p.alive = true;
    p.isImposter = false;
    p.secretWord = null;
    p.ready = false;
  }
  push(r);
}

function leave(r, p) {
  r.players.delete(p.id);
  if (!r.players.size) {
    clearTimeout(r.timer);
    clearTimeout(r.sceneTimer);
    rooms.delete(r.code);
    return;
  }
  if (r.host === p.id) {
    const nextHost = [...r.players.values()].find(x => x.on) || [...r.players.values()][0];
    r.host = nextHost.id;
  }
  if (r.game === 'werewolf' && r.phase === 'question' && checkWerewolfWin(r)) return;
  if (r.phase === 'question' && allDone(r)) reveal(r);
  else push(r);
}

function addPlayer(r, name, s) {
  const used = new Set([...r.players.values()].map(p => p.av));
  const p = {
    id: 'p' + ++r.seq,
    key: crypto.randomBytes(12).toString('hex'),
    name: clean(name, 12) || 'Oyuncu',
    av: AV.find(a => !used.has(a)) || '🎉',
    sid: s.id,
    on: true,
    off: 0,
    ready: false,
    team: null,
    spymaster: false,
    role: null,
    alive: true,
    isImposter: false,
    secretWord: null,
    score: 0,
    night: 0
  };
  r.players.set(p.id, p);
  s.data.code = r.code;
  s.data.id = p.id;
  return p;
}

function buildView(r, p) {
  const base = {
    code: r.code,
    me: p.id,
    host: r.host,
    phase: r.phase,
    game: r.game,
    mode: r.mode,
    cfg: {
      rounds: r.cfg.rounds,
      time: r.cfg.time,
      teams: r.cfg.teams,
      imposterCount: r.cfg.imposterCount || 1,
      imposterGuessBonus: Boolean(r.cfg.imposterGuessBonus),
    },
    round: r.round,
    teams: r.teams,
    players: [...r.players.values()].map(x => ({
      id: x.id,
      name: x.name,
      av: x.av,
      team: x.team,
      spymaster: Boolean(x.spymaster),
      alive: x.alive !== false,
      score: x.score,
      night: x.night,
      ready: x.ready,
      on: x.on,
      done: r.phase === 'question' && r.ans && r.ans.has(akey(r, x))
    })),
    left: r.phase === 'question' ? Math.max(0, r.deadline - Date.now()) : 0,
    totalMs: r.phase === 'question'
      ? ((r.activeSec || r.cfg.time || 20) * 1000 + (['song', 'film', 'pixel'].includes(r.game) && r.q && !r.q.loading ? 3000 : 0))
      : 0,
    mine: r.phase === 'question' && r.ans && r.ans.has(akey(r, p)),
    rev: r.phase === 'reveal' ? r.rev : null,
    mix: r.mix && r.mix.active ? {
      active: true,
      games: r.mix.games,
      currentGame: getActiveGameId(r),
      nextGame: r.mix.games[Math.floor((r.mix.completedRounds + 1) / r.mix.roundsPerGame) % r.mix.games.length],
      completedRounds: r.mix.completedRounds,
      totalRounds: r.mix.games.length * r.mix.roundsPerGame,
      roundsPerGame: r.mix.roundsPerGame
    } : null,
  };

  if (r.phase === 'question' || r.phase === 'reveal') {
    if (r.game === 'codenames' && r.cn) {
      base.cn = {
        turnTeam: r.cn.turnTeam,
        clue: r.cn.clue,
        guessesLeft: r.cn.guessesLeft,
        redLeft: r.cn.redLeft,
        blueLeft: r.cn.blueLeft,
        winnerTeam: r.cn.winnerTeam,
        reason: r.cn.reason,
        log: r.cn.log.slice(-8),
        isSpymaster: Boolean(p.spymaster),
        myTeam: p.team,
        cards: r.cn.cards.map(c => ({
          idx: c.idx,
          word: c.word,
          revealed: c.revealed,
          byTeam: c.byTeam,
          type: (c.revealed || p.spymaster) ? c.type : undefined
        }))
      };
      base.q = { t: `Codenames · ${r.cn.turnTeam === 0 ? 'Kırmızı' : 'Mavi'} Takım Sırası`, c: '5x5 Kelime Tahtası' };
    } else if (r.game === 'werewolf' && r.ww) {
      let detectiveResult = null;
      if (p.role === 'detective' && r.ww.nightActions.detectiveCheck) {
        const target = r.players.get(r.ww.nightActions.detectiveCheck);
        if (target) {
          detectiveResult = `${target.name}: ${target.role === 'werewolf' ? '🐺 VAMPİR' : '🏡 VAMPİR DEĞİL'}`;
        }
      }
      base.ww = {
        dayNum: r.ww.dayNum,
        subPhase: r.ww.subPhase,
        myRole: p.role,
        alive: p.alive,
        lastNightSummary: r.ww.lastNightSummary,
        lastVoteSummary: r.ww.lastVoteSummary,
        winner: r.ww.winner,
        history: r.ww.history.slice(-10),
        detectiveResult,
        votedCount: r.ww.votes ? r.ww.votes.size : 0,
        myVote: r.ww.votes ? r.ww.votes.get(p.id) || null : null
      };
      base.q = {
        t: r.ww.subPhase === 'night' ? `🌙 ${r.ww.dayNum}. Gece` : r.ww.subPhase === 'day_discuss' ? `☀️ ${r.ww.dayNum}. Gün · Tartışma` : `🗳️ ${r.ww.dayNum}. Gün · Oylama`,
        c: 'Vampir Köylü'
      };
    } else if (r.game === 'imposter' && r.imp) {
      base.imp = {
        category: r.imp.category,
        subPhase: r.imp.subPhase,
        myWord: p.secretWord || '',
        isImposter: Boolean(p.isImposter),
        clues: r.imp.clues,
        votedCount: r.imp.votes ? r.imp.votes.size : 0,
        myVote: r.imp.votes ? r.imp.votes.get(p.id) || null : null,
        caughtTargetId: r.imp.caughtTargetId || null
      };
      base.q = { t: `🕵️ Gizli Kelime (${r.imp.category})`, c: 'Imposter' };
    } else if ((r.game === 'song' || r.game === 'film' || r.game === 'pixel') && r.q && r.q.loading) {
      base.q = { t: r.q.t, c: '', u: '', loading: true };
    } else if (r.game === 'song' && r.q) {
      base.q = {
        t: r.q.t,
        c: r.q.c,
        u: r.q.u || '',
        clipSec: r.q.clipSec,
        audio: r.q.audio,
        seek: r.q.seek,
        playAt: r.q.playAt,
        serverNow: Date.now(),
        penaltyLeft: (r.penaltyUntil && r.penaltyUntil.get(p.id)) ? Math.max(0, r.penaltyUntil.get(p.id) - Date.now()) : 0
      };
    } else if ((r.game === 'film' || r.game === 'pixel') && r.q) {
      const idx = Math.min(r.q.sceneIndex || 0, r.q.scenes.length - 1);
      base.q = {
        t: r.q.t,
        c: r.q.c,
        u: r.q.u || '',
        sceneIndex: idx,
        serverNow: Date.now(),
        nextAt: r.q.nextAt || 0,
        penaltyLeft: (r.penaltyUntil && r.penaltyUntil.get(p.id)) ? Math.max(0, r.penaltyUntil.get(p.id) - Date.now()) : 0,
        totalScenes: r.q.scenes.length,
        unlockedScenes: r.q.scenes.slice(0, idx + 1)
      };
    } else if (r.q) {
      base.q = { t: r.q.t, o: r.q.o, c: r.q.c, u: r.q.u || '' };
    }
  }

  return base;
}

function push(r) {
  for (const p of r.players.values()) {
    if (p.on && p.sid) {
      io.to(p.sid).emit('s', buildView(r, p));
    }
  }
}

const partial = (full, g) => g.length >= Math.max(4, Math.ceil(full.length * 0.5)) && full.includes(g);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchTarget(guess, target) {
  const x = norm(target);
  if (!x) return false;
  if (x.length < 4) return guess === x || new RegExp('(?:^|\\s)' + escRe(x) + '(?:$|\\s)').test(guess);
  return guess.includes(x) || partial(x, guess);
}

function checkTextGuessMatch(gameId, q, rawText) {
  const guess = norm(rawText);
  if (!guess) return false;
  if (gameId === 'emoji') {
    return (q.a || []).some(ans => matchTarget(guess, ans));
  }
  if (gameId === 'song') {
    return matchTarget(guess, q.title);
  }
  if (gameId === 'film' || gameId === 'pixel') {
    return (q.answers || []).some(ans => matchTarget(guess, ans));
  }
  return false;
}

const srv = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }
  if (urlPath === '/pixel-check' || urlPath === '/pixel-stats') {
    if (urlPath === '/pixel-check') media.pixelCheck(pixelPool);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ pool: pixelPool.length, ...media.pixelStats() }));
  }
  if (urlPath === '/catalog') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      musicCategories: customCatalog.musicCategories,
      artistsTr: customCatalog.artistsTr,
      artistsEn: customCatalog.artistsEn,
      musicCount: customCatalog.music.length,
      filmCategories: customCatalog.filmCategories,
      filmSeries: customCatalog.filmSeries,
      filmCount: customCatalog.films.length,
      tmdb: media.hasTmdb(),
      qCats: Object.fromEntries(Object.keys(QCAT_BANK).map(g => [g, [...new Set(gameCats(g))]])),
      pixelCats: [...new Set(pixelPool.map(x => x.c))],
      pixelCount: pixelPool.length,
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
});

const io = new Server(srv, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 2e4 });

io.on('connection', s => {
  s.on('create', (name, cb) => {
    if (s.data.code || typeof cb !== 'function') return;
    const code = newCode();
    const r = {
      code,
      host: null,
      players: new Map(),
      seq: 0,
      phase: 'lobby',
      game: 'tf',
      mode: 'solo',
      cfg: {
        rounds: 5,
        time: 20,
        teams: 2,
        imposterCount: 1,
        imposterGuessBonus: true,
        musicFilter: sanitizeMusicFilter({}),
        filmFilter: sanitizeFilmFilter({}),
      },
      mix: null,
      teams: [],
      round: 0,
      ans: new Map(),
      usedKeys: new Set(),
      lastKeys: new Map(),
      idle: Date.now()
    };
    rooms.set(code, r);
    const hostPlayer = addPlayer(r, name, s);
    r.host = hostPlayer.id;
    cb({ code: r.code, key: hostPlayer.key });
    push(r);
  });

  s.on('join', (code, name, cb) => {
    if (s.data.code || typeof cb !== 'function') return;
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return cb({ err: 'Oda bulunamadı. Kodu kontrol et.' });
    if (r.players.size >= 10) return cb({ err: 'Oda dolu (10/10).' });
    if (r.phase !== 'lobby') return cb({ err: 'Oyun başladı. Bir sonraki oyunu bekle.' });
    const p = addPlayer(r, name, s);
    cb({ code: r.code, key: p.key });
    push(r);
  });

  s.on('rejoin', (code, key, cb) => {
    const r = rooms.get(String(code || '').toUpperCase().trim());
    const p = r && [...r.players.values()].find(x => x.key === key);
    if (!p || typeof cb !== 'function') return typeof cb === 'function' && cb({ err: 1 });
    p.sid = s.id;
    p.on = true;
    p.off = 0;
    s.data.code = r.code;
    s.data.id = p.id;
    cb({ ok: 1 });
    push(r);
  });

  s.on('ready', () => {
    const [r, p] = me(s);
    if (r && r.phase === 'lobby') {
      p.ready = !p.ready;
      push(r);
    }
  });

  s.on('catalog:add', (payload, cb) => {
    const [r, p] = me(s);
    if (!r || r.host !== p.id || !payload || typeof payload !== 'object') {
      return typeof cb === 'function' && cb({ ok: false, err: 'Yetkisiz işlem.' });
    }
    const kind = payload.kind;
    if (kind === 'artist') {
      const n = clean(payload.name, 40);
      if (!n) return typeof cb === 'function' && cb({ ok: false, err: 'Sanatçı adı gerekli.' });
      if (payload.region === 'en') {
        if (!customCatalog.artistsEn.includes(n)) customCatalog.artistsEn.push(n);
      } else {
        if (!customCatalog.artistsTr.includes(n)) customCatalog.artistsTr.push(n);
      }
      return typeof cb === 'function' && cb({ ok: true });
    }
    if (kind === 'series') {
      const n = clean(payload.name, 50);
      if (n && !customCatalog.filmSeries.includes(n)) customCatalog.filmSeries.push(n);
      return typeof cb === 'function' && cb({ ok: true });
    }
    if (kind === 'song') {
      const title = clean(payload.title, 60);
      const artist = clean(payload.artist, 50);
      if (!title || !artist) return typeof cb === 'function' && cb({ ok: false, err: 'Şarkı adı ve sanatçı zorunlu.' });
      const genre = clean(payload.genre, 30) || 'Karışık';
      const year = clamp(payload.year, 1950, 2026, 2020);
      customCatalog.music.push({
        id: 'm_custom_' + Date.now(),
        title,
        artist,
        lang: payload.lang === 'en' ? 'en' : 'tr',
        genres: [genre, 'Karışık'],
        year,
        pop: 'high'
      });
      return typeof cb === 'function' && cb({ ok: true });
    }
    if (kind === 'film') {
      const title = clean(payload.title, 70);
      if (!title) return typeof cb === 'function' && cb({ ok: false, err: 'Film adı zorunlu.' });
      const year = clamp(payload.year, 1920, 2026, 2020);
      const cat = clean(payload.category, 30) || 'Hollywood';
      customCatalog.films.push({
        id: 'f_custom_' + Date.now(),
        title,
        year,
        region: cat === 'Türk Sineması' ? 'tr' : 'hollywood',
        categories: [cat, 'Yeni Filmler'],
        series: clean(payload.series, 50) || '',
        pop: 'high',
        images: String(payload.images || '').split(/\s+/).filter(u => /^https:\/\/[^\s<>"']{6,300}$/i.test(u)).slice(0, 8),
        answers: [norm(title)]
      });
      return typeof cb === 'function' && cb({ ok: true });
    }
    return typeof cb === 'function' && cb({ ok: false, err: 'Bilinmeyen içerik türü.' });
  });

  s.on('start', c => {
    const [r, p] = me(s);
    if (!r || r.host !== p.id || r.phase !== 'lobby' || !c || typeof c !== 'object') return;

    const ps = [...r.players.values()];
    const rounds = [5, 10, 15, 20, 25, 30, 40, 50, 0].includes(Number(c.rounds)) ? Number(c.rounds) : 5;
    const time = clamp(c.time, 10, 60, 20);
    const teamsCount = clamp(c.teams, 2, 4, 2);
    const imposterCount = clamp(c.imposterCount, 1, 3, 1);
    const wantsFilm = c.game === 'film' || (c.mixMode && Array.isArray(c.mixGames) && c.mixGames.includes('film'));
    if (wantsFilm && !media.hasTmdb()) return s.emit('toast', 'Film oyunu için sunucuda TMDB_API_KEY tanımlı olmalı (Render → Environment).');

    if (c.mixMode) {
      const validMix = [...new Set(c.mixGames || [])]
        .filter(gid => MIX_ALLOWED.has(gid) && !MIX_FORBIDDEN.has(gid))
        .slice(0, 4);
      if (validMix.length < 2) return s.emit('toast', 'Karma Mod için en az 2 uyumlu oyun seçin.');
    } else {
      if (c.game === 'codenames' && ps.length < 4) return s.emit('toast', 'Codenames için en az 4 oyuncu gerekli.');
      if (c.game === 'imposter' && ps.length < 4) return s.emit('toast', 'Imposter için en az 4 oyuncu gerekli.');
      if (c.game === 'werewolf' && ps.length < 5) return s.emit('toast', 'Vampir Köylü için en az 5 oyuncu gerekli.');
    }

    r.cfg = {
      cats: c.mixMode ? [] : sanitizeCats(c.cats, c.game),
      rounds,
      time,
      teams: teamsCount,
      imposterCount,
      imposterGuessBonus: c.imposterGuessBonus !== false,
      wwNight: clamp(c.wwNight, 10, 90, time),
      wwDay: clamp(c.wwDay, 15, 180, 45),
      wwVote: clamp(c.wwVote, 10, 120, 25),
      musicFilter: sanitizeMusicFilter(c.musicFilter),
      filmFilter: sanitizeFilmFilter(c.filmFilter),
    };

    for (const x of ps) {
      x.score = 0;
      x.team = null;
      x.spymaster = false;
      x.role = null;
      x.alive = true;
      x.isImposter = false;
      x.secretWord = null;
    }
    r.teams = [];
    r.cn = null;
    r.ww = null;
    r.imp = null;
    r.mix = null;

    if (c.mixMode && Array.isArray(c.mixGames)) {
      const validMix = [...new Set(c.mixGames)]
        .filter(gid => MIX_ALLOWED.has(gid) && !MIX_FORBIDDEN.has(gid))
        .slice(0, 4);
      if (validMix.length >= 2) {
        const perGame = clamp(c.mixRoundsPerGame, 1, 5, 2);
        r.mix = {
          active: true,
          games: validMix,
          step: 0,
          roundsPerGame: perGame,
          completedRounds: 0
        };
        r.game = validMix[0];
        r.mode = 'solo';
        r.round = 0;
        startRound(r);
        return;
      }
    }

    const reqGame = ALL_GAMES.has(c.game) ? c.game : 'tf';
    r.game = reqGame;

    if (reqGame === 'codenames') {
      r.round = 0;
      startRound(r);
      return;
    }

    if (reqGame === 'werewolf' || reqGame === 'imposter') {
      r.mode = 'solo';
      r.round = 0;
      startRound(r);
      return;
    }

    const n = Math.min(teamsCount, ps.length);
    r.mode = c.mode === 'team' && n >= 2 ? 'team' : 'solo';
    if (r.mode === 'team') {
      r.teams = TEAMS.slice(0, n).map(([name, color]) => ({ name, color, score: 0 }));
      shuffle(ps).forEach((x, i) => {
        x.team = i % n;
      });
    }

    r.round = 0;
    startRound(r);
  });

  s.on('cn:swap_spy', () => {
    const [r, p] = me(s);
    if (!r || r.host !== p.id || r.phase !== 'question' || r.game !== 'codenames' || !r.cn) return;
    [0, 1].forEach(tIdx => {
      const teamPlayers = [...r.players.values()].filter(x => x.team === tIdx);
      if (teamPlayers.length >= 2) {
        const curIdx = teamPlayers.findIndex(x => x.spymaster);
        teamPlayers.forEach(x => { x.spymaster = false; });
        const nextIdx = (curIdx + 1) % teamPlayers.length;
        teamPlayers[nextIdx].spymaster = true;
      }
    });
    r.cn.log.push('Oda sahibi takım liderlerini güncelledi.');
    push(r);
  });

  s.on('cn:clue', payload => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'codenames' || !r.cn || r.cn.winnerTeam != null) return;
    if (!p.spymaster || p.team !== r.cn.turnTeam || r.cn.clue) return;
    if (!payload || typeof payload !== 'object') return;
    const word = clean(payload.word, 24).toUpperCase();
    const count = clamp(payload.count, 1, 9, 1);
    if (!word) return;
    r.cn.clue = { word, count, by: p.name };
    r.cn.guessesLeft = count + 1;
    r.cn.log.push(`${p.name} (${p.team === 0 ? 'Kırmızı' : 'Mavi'} Lider) ipucu verdi: "${word}" · ${count}`);
    push(r);
  });

  s.on('cn:pick', idx => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'codenames' || !r.cn || r.cn.winnerTeam != null) return;
    if (p.spymaster || p.team !== r.cn.turnTeam || !r.cn.clue || r.cn.guessesLeft <= 0) return;
    const card = r.cn.cards[+idx];
    if (!card || card.revealed) return;

    card.revealed = true;
    card.byTeam = p.team;
    if (card.type === 'red') r.cn.redLeft = Math.max(0, r.cn.redLeft - 1);
    if (card.type === 'blue') r.cn.blueLeft = Math.max(0, r.cn.blueLeft - 1);

    const mySide = p.team === 0 ? 'red' : 'blue';
    const oppTeam = p.team === 0 ? 1 : 0;

    if (card.type === 'assassin') {
      r.cn.winnerTeam = oppTeam;
      r.cn.reason = `${p.name} SİYAH KART ("${card.word}") seçti! ${oppTeam === 0 ? 'Kırmızı' : 'Mavi'} takım kazandı.`;
      r.cn.log.push(r.cn.reason);
      if (r.teams[oppTeam]) r.teams[oppTeam].score += 150;
      finish(r);
      return;
    }

    if (r.cn.redLeft === 0 || r.cn.blueLeft === 0) {
      const winT = r.cn.redLeft === 0 ? 0 : 1;
      r.cn.winnerTeam = winT;
      r.cn.reason = `Tüm kelimeler bulundu! ${winT === 0 ? 'Kırmızı' : 'Mavi'} takım kazandı.`;
      r.cn.log.push(r.cn.reason);
      if (r.teams[winT]) r.teams[winT].score += 150;
      finish(r);
      return;
    }

    if (card.type === mySide) {
      if (r.teams[p.team]) r.teams[p.team].score += 25;
      r.cn.guessesLeft--;
      r.cn.log.push(`${p.name} doğru kartı buldu: "${card.word}".`);
      if (r.cn.guessesLeft <= 0) {
        r.cn.clue = null;
        r.cn.turnTeam = oppTeam;
        r.cn.log.push(`Tahmin hakkı bitti; sıra ${oppTeam === 0 ? 'Kırmızı' : 'Mavi'} takıma geçti.`);
      }
    } else if (card.type === 'neutral') {
      r.cn.clue = null;
      r.cn.guessesLeft = 0;
      r.cn.turnTeam = oppTeam;
      r.cn.log.push(`${p.name} tarafsız kart ("${card.word}") seçti; sıra karşı takıma geçti.`);
    } else {
      if (r.teams[oppTeam]) r.teams[oppTeam].score += 35;
      r.cn.clue = null;
      r.cn.guessesLeft = 0;
      r.cn.turnTeam = oppTeam;
      r.cn.log.push(`${p.name} rakip kart ("${card.word}") seçti; rakip +35 puan aldı ve sıra geçti.`);
    }
    push(r);
  });

  s.on('cn:end_turn', () => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'codenames' || !r.cn || r.cn.winnerTeam != null) return;
    if (p.team !== r.cn.turnTeam) return;
    r.cn.clue = null;
    r.cn.guessesLeft = 0;
    r.cn.turnTeam = r.cn.turnTeam === 0 ? 1 : 0;
    r.cn.log.push(`Sıra devredildi → ${r.cn.turnTeam === 0 ? 'Kırmızı' : 'Mavi'} takım.`);
    push(r);
  });

  s.on('ww:night_action', targetId => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'werewolf' || !r.ww || r.ww.subPhase !== 'night') return;
    if (!p.alive) return;
    const target = r.players.get(String(targetId));
    if (!target || !target.alive) return;

    if (p.role === 'werewolf') {
      r.ww.nightActions.wolfTarget = target.id;
      r.ans.set(p.id, { v: target.id, t: Date.now() });
    } else if (p.role === 'doctor') {
      r.ww.nightActions.doctorSave = target.id;
      r.ans.set(p.id, { v: target.id, t: Date.now() });
    } else if (p.role === 'detective') {
      r.ww.nightActions.detectiveCheck = target.id;
      r.ans.set(p.id, { v: target.id, t: Date.now() });
    }
    push(r);
  });

  s.on('ww:vote', targetId => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'werewolf' || !r.ww || r.ww.subPhase !== 'day_vote') return;
    if (!p.alive) return;
    const target = r.players.get(String(targetId));
    if (!target || !target.alive) return;
    r.ww.votes.set(p.id, target.id);
    push(r);
  });

  s.on('imp:clue', text => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'imposter' || !r.imp || r.imp.subPhase !== 'clues') return;
    const t = clean(text, 60);
    if (!t) return;
    if (r.imp.clues.some(x => x.pid === p.id)) return;
    r.imp.clues.push({ pid: p.id, name: p.name, av: p.av, text: t });
    if (r.imp.clues.length >= activePlayers(r).length) {
      clearTimeout(r.timer);
      const voteSec = Math.max(15, Math.round((r.cfg.time || 30) * 0.7));
      r.imp.subPhase = 'vote';
      r.deadline = Date.now() + voteSec * 1000;
      r.timer = setTimeout(() => resolveImposterVote(r), voteSec * 1000);
    }
    push(r);
  });

  s.on('imp:vote', targetId => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'imposter' || !r.imp || r.imp.subPhase !== 'vote') return;
    const target = r.players.get(String(targetId));
    if (!target) return;
    r.imp.votes.set(p.id, target.id);
    const activeCount = activePlayers(r).length;
    if (r.imp.votes.size >= activeCount && activeCount > 0) {
      resolveImposterVote(r);
    } else {
      push(r);
    }
  });

  s.on('imp:guess', word => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question' || r.game !== 'imposter' || !r.imp || r.imp.subPhase !== 'guess_common') return;
    if (!p.isImposter || r.imp.guessAttempted) return;
    r.imp.guessAttempted = true;
    const guessedCorrectly = norm(word) === norm(r.imp.commonWord);
    finalizeImposterResult(r, !guessedCorrectly);
  });

  s.on('answer', v => {
    const [r, p] = me(s);
    if (!r || r.phase !== 'question') return;
    if (['codenames', 'werewolf', 'imposter'].includes(r.game)) return;

    const k = akey(r, p);
    if (r.ans.has(k)) return;

    if (r.q && r.q.loading) return;
    if ((r.game === 'song' || r.game === 'film' || r.game === 'pixel') && r.penaltyUntil && (r.penaltyUntil.get(p.id) || 0) > Date.now()) {
      return;
    }

    if (r.game === 'tf' || r.game === 'quiz' || r.game === 'liar' || r.game === 'wyr' || r.game === 'ml') {
      const optLen = (r.q && Array.isArray(r.q.o)) ? r.q.o.length : 0;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= optLen) return;
      r.ans.set(k, { v, t: Date.now() });
    } else if (r.game === 'closest') {
      const num = Number(v);
      if (!Number.isFinite(num) || Math.abs(num) > 1e12) return;
      r.ans.set(k, { v: num, t: Date.now() });
    } else if (r.game === 'emoji' || r.game === 'song' || r.game === 'film' || r.game === 'pixel') {
      const txt = clean(v, 50);
      if (!txt) return;
      const ok = checkTextGuessMatch(r.game, r.q, txt);
      if (ok) {
        r.ans.set(k, { v: txt, ok: true, t: Date.now(), fi: (r.q && r.q.sceneIndex) || 0 });
      } else {
        if (r.game === 'song' || r.game === 'film' || r.game === 'pixel') {
          r.penaltyUntil.set(p.id, Date.now() + 3000);
          s.emit('toast', 'Yanlış tahmin! 3 sn bekleme cezası.');
          push(r);
          return;
        }
        r.ans.set(k, { v: txt, ok: false, t: Date.now() });
      }
    }

    if (allDone(r)) reveal(r);
    else push(r);
  });

  s.on('stop', () => {
    const [r, p] = me(s);
    if (!r || r.host !== p.id) return;
    if (r.phase === 'end') toLobby(r);
    else if (r.phase !== 'lobby') finish(r);
  });

  s.on('reset', () => {
    const [r, p] = me(s);
    if (!r || r.host !== p.id) return;
    for (const x of r.players.values()) {
      x.night = 0;
      x.score = 0;
    }
    push(r);
  });

  s.on('kick', id => {
    const [r, p] = me(s);
    if (!r || r.host !== p.id || id === p.id) return;
    const t = r.players.get(id);
    if (!t) return;
    if (t.sid) io.to(t.sid).emit('kicked');
    leave(r, t);
  });

  s.on('leave', () => {
    const [r, p] = me(s);
    if (r) leave(r, p);
    s.data = {};
  });

  s.on('disconnect', () => {
    const [r, p] = me(s);
    if (!r || p.sid !== s.id) return;
    p.on = false;
    p.off = Date.now();
    if (r.host === p.id) {
      const n = [...r.players.values()].find(x => x.on);
      if (n) r.host = n.id;
    }
    if (r.phase === 'question' && allDone(r)) reveal(r);
    else push(r);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) {
    if ([...r.players.values()].some(p => p.on)) {
      r.idle = now;
      if (r.phase === 'lobby') {
        for (const p of [...r.players.values()]) {
          if (!p.on && p.off && now - p.off > 120000) leave(r, p);
        }
      }
    } else if (now - r.idle > 300000) {
      clearTimeout(r.timer);
      clearTimeout(r.sceneTimer);
      rooms.delete(c);
    }
  }
}, 30000);

srv.listen(PORT, '0.0.0.0', () => console.log('Parti Odası hazır: http://localhost:' + PORT));
