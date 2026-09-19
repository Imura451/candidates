#!/usr/bin/env node
/*
 * 候補者紹介LP ジェネレータ
 *
 * 「顔写真」「簡単な候補者情報」「インタビュー動画」の3点だけを載せる、
 * 軽い紹介ページを候補者1人につき1ファイルのHTMLで書き出します。
 * 詳しい経歴は履歴書で別途お渡しする前提です。
 * Node.js 標準機能のみ。外部パッケージ不使用。
 *
 *   node build.js            … data/*.json をすべてビルド
 *   node build.js --clean    … docs/c/ の孤児HTML（元データが消えたもの）も削除
 *
 * 入力: data/<id>.json（_ で始まるファイルは対象外）
 *       assets/photos/<slug>/face.jpg（顔写真。フォルダは初回ビルドで自動作成）
 * 雛形: src/template.html + src/style.css（ビルド時にCSSをHTMLへ埋め込む）
 * 出力: docs/c/<国コード>-<8桁>.html （1ファイル完結）
 *
 * URLの8桁は data/_salt.txt（秘密の文字列）と id から計算します。
 * 手元でも GitHub Actions でも同じ値になるので、どこでビルドしてもURLは変わりません。
 * data/_slugs.json に書いてある id はそちらが優先されます（配布済みURLを守るため）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SRC_DIR = path.join(ROOT, 'src');
const DOCS_DIR = path.join(ROOT, 'docs');
const OUT_DIR = path.join(DOCS_DIR, 'c');
const ASSET_DIR = path.join(ROOT, 'assets');
const PHOTO_DIR = path.join(ASSET_DIR, 'photos');
const SLUG_FILE = path.join(DATA_DIR, '_slugs.json');
const SALT_FILE = path.join(DATA_DIR, '_salt.txt');

const CLEAN = process.argv.includes('--clean');
const IN_CI = !!process.env.GITHUB_ACTIONS;

/* ------------------------------------------------------------------ *
 * 会社情報（ここだけ直せば全ページに反映されます）
 * 電話番号と住所はページに載せません。問い合わせはメールに一本化します。
 * ------------------------------------------------------------------ */
const COMPANY = {
  brand: 'ガイコクジンコネクト',
  corp: '株式会社Minobordo',
  person: '井村 稔',
  title: '代表取締役',
  mail: 'gaikokujin18@gmail.com',
  // 独自ドメイン gaikokujinconnect.jp はまだ使えません（DNSに登録がありません）。
  // 取得して Cloudflare につないだら、ここを差し替えてください。
  site: 'https://gaikokujinconnect.d4station-info.workers.dev'
};

/* ------------------------------------------------------------------ *
 * 公開URLの根元
 *
 * GitHub のアカウント名と保存先の名前から決まります。
 *   https://<アカウント名>.github.io/<保存先の名前>/
 *
 * 実際に GitHub につないだあとは、git の設定から自動で読み取るので
 * ここを直す必要はありません。まだつないでいない間だけ、この値を使います。
 * ------------------------------------------------------------------ */
const PAGES_BASE = 'https://imura451.github.io/candidates/';

/* ------------------------------------------------------------------ *
 * 人材バンクの絞り込みで使う区分
 * ------------------------------------------------------------------ */

/* 在留資格。この順に並びます。JSONの info.residence にはこの文字を書きます */
const RESIDENCES = ['特定技能1号', '特定技能2号', '育成就労・技能実習', '技人国', '未定'];

/* カードと個別ページでの表示（書いていないものは、そのまま出します） */
const RES_CARD = {
  '技人国': '技人国（技術・人文知識・国際業務）',
  '未定': '在留資格は検討中'
};

/* 絞り込みボタンでの表示 */
const RES_PILL = { '未定': '未定・検討中' };

/* 特定技能1号の分野。この順に並びます。制度が変わったら足してください */
const FIELDS = [
  '介護', 'ビルクリーニング', '工業製品製造業', '建設', '造船・舶用工業', '自動車整備',
  '航空', '宿泊', '自動車運送業', '鉄道', '農業', '漁業', '飲食料品製造業', '外食業',
  '林業', '木材産業'
];

/* 日本語。code → 絞り込みボタンの文字 */
const JP_LEVELS = [
  ['N1', 'N1'], ['N2', 'N2'], ['N3', 'N3'], ['N4', 'N4'], ['N5', 'N5'],
  ['JFT', 'JFT-Basic 合格']
];

/* status の値 */
const ST_OPEN = '求職中';
const ST_CLOSED = '決定';

/* 基本情報の表に出す項目（この順で出ます。値の無い行は消えます） */
const INFO_ROWS = [
  ['visa', '在留資格'],
  ['japanese', '日本語'],
  ['japanStay', '日本での生活'],
  ['experience', '実務経験'],
  ['workArea', '希望勤務地'],
  ['availableFrom', '入社可能時期']
];

/* ================================================================== *
 * 1. ごく小さなテンプレートエンジン（Mustache 風）
 *    {{key}}      … HTMLエスケープして差し込む
 *    {{&key}}     … エスケープせず差し込む
 *    {{#key}}…{{/key}} … 値があるときだけ出す（配列なら繰り返す）
 *    {{^key}}…{{/key}} … 値が無いときだけ出す
 *    {{.}}        … 配列の要素そのもの
 * ================================================================== */
const TOKEN = /\{\{(!|#|\^|\/|&|\{)?\s*([\w.\-]*)\s*\}?\}\}/g;

function parse(tpl) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(tpl)) !== null) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ type: 'text', value: tpl.slice(last, m.index) });
    last = m.index + m[0].length;
    const sigil = m[1], name = m[2];
    if (sigil === '#' || sigil === '^') {
      const node = { type: sigil === '#' ? 'section' : 'inverted', name, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (sigil === '/') {
      if (stack.length === 1) throw new Error('テンプレートの {{/' + name + '}} が対応していません');
      stack.pop();
    } else if (sigil === '!') {
      /* コメント */
    } else {
      top.children.push({ type: 'var', name, raw: sigil === '&' || sigil === '{' });
    }
  }
  if (last < tpl.length) stack[stack.length - 1].children.push({ type: 'text', value: tpl.slice(last) });
  if (stack.length !== 1) throw new Error('テンプレートの {{#…}} が閉じられていません');
  return root;
}

function lookup(stack, name) {
  if (name === '.') return stack[stack.length - 1];
  const parts = name.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    let cur = stack[i];
    let ok = true;
    for (const p of parts) {
      if (cur !== null && typeof cur === 'object' && p in cur) cur = cur[p];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined) return cur;
  }
  return undefined;
}

function truthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return true;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderNodes(nodes, stack) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') { out += n.value; continue; }
    if (n.type === 'var') {
      const v = lookup(stack, n.name);
      if (v === undefined || v === null || v === false) continue;
      out += n.raw ? String(v) : esc(v);
      continue;
    }
    const v = lookup(stack, n.name);
    if (n.type === 'section') {
      if (!truthy(v)) continue;
      if (Array.isArray(v)) {
        v.forEach((item, i) => {
          const meta = { _i: i, _n: i + 1, _first: i === 0, _last: i === v.length - 1 };
          out += renderNodes(n.children, stack.concat([meta, item]));
        });
      } else {
        out += renderNodes(n.children, stack.concat([v]));
      }
    } else if (n.type === 'inverted') {
      if (!truthy(v)) out += renderNodes(n.children, stack.concat([{}]));
    }
  }
  return out;
}

function render(tpl, data) {
  return renderNodes(parse(tpl).children, [data]);
}

/* ================================================================== *
 * 2. 国旗（インラインSVG・CDN不使用）
 * ================================================================== */
const STAR = 'M0,-1 L0.225,-0.309 L0.951,-0.309 L0.363,0.118 L0.588,0.809 ' +
             'L0,0.382 L-0.588,0.809 L-0.363,0.118 L-0.951,-0.309 L-0.225,-0.309 Z';

const FLAGS = {
  VN: `<svg viewBox="0 0 30 20" role="img" aria-label="ベトナム"><rect width="30" height="20" fill="#DA251D"/><path d="${STAR}" fill="#FFFF00" transform="translate(15 10) scale(6.2)"/></svg>`,
  PH: `<svg viewBox="0 0 30 20" role="img" aria-label="フィリピン"><rect width="30" height="10" fill="#0038A8"/><rect y="10" width="30" height="10" fill="#CE1126"/><path d="M0,0 L13,10 L0,20 Z" fill="#fff"/><circle cx="4.6" cy="10" r="2.1" fill="#FCD116"/><path d="${STAR}" fill="#FCD116" transform="translate(1.6 1.6) scale(1.1)"/><path d="${STAR}" fill="#FCD116" transform="translate(1.6 18.4) scale(1.1)"/><path d="${STAR}" fill="#FCD116" transform="translate(10.6 10) scale(1.1)"/></svg>`,
  BD: `<svg viewBox="0 0 30 20" role="img" aria-label="バングラデシュ"><rect width="30" height="20" fill="#006A4E"/><circle cx="13.5" cy="10" r="6" fill="#F42A41"/></svg>`,
  ID: `<svg viewBox="0 0 30 20" role="img" aria-label="インドネシア"><rect width="30" height="10" fill="#CE1126"/><rect y="10" width="30" height="10" fill="#fff"/></svg>`,
  LK: `<svg viewBox="0 0 30 20" role="img" aria-label="スリランカ"><rect width="30" height="20" fill="#FFBE29"/><rect x="1.4" y="1.4" width="2.5" height="17.2" fill="#00534E"/><rect x="3.9" y="1.4" width="2.5" height="17.2" fill="#EB7400"/><rect x="7.6" y="1.4" width="21" height="17.2" fill="#8D153A"/><g fill="#FFBE29"><ellipse cx="9.6" cy="3.4" rx="1" ry="1.4"/><ellipse cx="26.6" cy="3.4" rx="1" ry="1.4"/><ellipse cx="9.6" cy="16.6" rx="1" ry="1.4"/><ellipse cx="26.6" cy="16.6" rx="1" ry="1.4"/><path d="M17 5.4c2.6 0 4.4 2 4.4 4.6s-1.8 4.6-4.4 4.6c-1.6 0-2.8-.8-3.4-2 .8.4 1.8.2 2.2-.6.4-.8.2-1.6-.4-2.2.6-.2 1-.8 1-1.4 0-.6-.4-1.2-1-1.4.5-.9 1.1-1.6 1.6-1.6z"/><path d="M21.6 6.2l2.6-1.8-.5 3z"/></g></svg>`,
  GH: `<svg viewBox="0 0 30 20" role="img" aria-label="ガーナ"><rect width="30" height="6.67" fill="#CE1126"/><rect y="6.67" width="30" height="6.67" fill="#FCD116"/><rect y="13.34" width="30" height="6.66" fill="#006B3F"/><path d="${STAR}" fill="#000" transform="translate(15 10) scale(3)"/></svg>`,
  NP: `<svg viewBox="0 0 30 20" role="img" aria-label="ネパール"><g transform="translate(6.5 0.6) scale(0.157)"><path d="M0,0 L74,44 L45,68 L100,110 L0,122 Z" fill="#DC143C" stroke="#003893" stroke-width="7" stroke-linejoin="round"/><g fill="#fff"><path d="M30 34a11 11 0 1 1-13-13 9 9 0 0 0 13 13z"/><circle cx="34" cy="88" r="12"/><path d="M34 70l3.5 7h-7zM34 106l3.5-7h-7zM16 88l7 3.5v-7zM52 88l-7 3.5v-7zM21 75l7 3-4 4zM47 101l-7-3 4-4zM47 75l-3 7-4-4zM21 101l3-7 4 4z"/></g></g></svg>`
};

const FLAG_FALLBACK = code =>
  `<svg viewBox="0 0 30 20" role="img"><rect width="30" height="20" fill="#fff" stroke="#6B7280"/><text x="15" y="14" text-anchor="middle" font-size="9" fill="#1A1A1A">${esc(code || '?')}</text></svg>`;

/* ================================================================== *
 * 3. ユーティリティ
 * ================================================================== */
const warnings = [];
const warn = m => { warnings.push(m); };

function s(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

/** 文字列 or {value, note} を {value, note} に正規化。空なら null */
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const value = s(v.value);
    return value ? { value, note: s(v.note) } : null;
  }
  const value = s(v);
  return value ? { value, note: '' } : null;
}

function arr(v) { return Array.isArray(v) ? v.map(s).filter(Boolean) : []; }

/* 紛らわしい l,o,0,1 は除外した32文字 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomString(n) {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 秘密の文字列を読む。無ければ手元では作る。GitHub Actions では止める（URLが変わってしまうため） */
function loadSalt() {
  if (fs.existsSync(SALT_FILE)) {
    const v = fs.readFileSync(SALT_FILE, 'utf8').trim();
    if (v.length >= 16) return v;
    console.error('エラー: data/_salt.txt が短すぎます（16文字以上）。');
    process.exit(1);
  }
  if (IN_CI) {
    console.error('エラー: data/_salt.txt がありません。手元で node build.js を実行して作られたファイルを git に含めてください。');
    process.exit(1);
  }
  const v = randomString(32);
  fs.writeFileSync(SALT_FILE, v + '\n', 'utf8');
  console.log('  作成: data/_salt.txt  ← URLを決める秘密の文字列です。消したり変えたりしないでください。');
  return v;
}

/** id と秘密の文字列から、URLの8桁を決める（毎回同じ値になる） */
function slugFor(code, id, salt) {
  const h = crypto.createHmac('sha256', salt).update(id).digest();
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return `${code}-${out}`;
}

/** 公開URLの根元。GitHub Actions 上なら環境変数から、手元なら git の remote から推定 */
function pagesBase() {
  let repo = s(process.env.GITHUB_REPOSITORY);            // owner/name
  if (!repo) {
    try {
      const url = execSync('git config --get remote.origin.url', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
      if (m) repo = `${m[1]}/${m[2]}`;
    } catch (e) { /* git 未設定なら無視 */ }
  }
  if (!repo) return PAGES_BASE;                           // まだ GitHub につないでいないとき
  const [owner, name] = repo.split('/');
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** ローカル画像を base64 で埋め込む。http(s) / data: ならそのまま返す */
function inlineImage(p, who) {
  const v = s(p);
  if (!v) return '';
  if (/^(https?:|data:)/i.test(v)) return v;
  const abs = path.isAbsolute(v) ? v : path.join(ROOT, v);
  if (!fs.existsSync(abs)) { warn(`${who}: 画像が見つかりません → ${v}`); return ''; }
  const ext = path.extname(abs).toLowerCase();
  if (!MIME[ext]) { warn(`${who}: 対応していない画像形式です → ${v}`); return ''; }
  return `data:${MIME[ext]};base64,` + fs.readFileSync(abs).toString('base64');
}

/**
 * 候補者の写真を探す。
 *   1. JSONに書いた値が http(s) / data: ならそのまま
 *   2. JSONに書いた値を assets/photos/<slug>/ の中 → プロジェクト直下 の順に探す
 *   3. JSONが空なら assets/photos/<slug>/<kind>.(jpg|jpeg|png|webp|gif) を自動で探す
 * 見つからなければ空文字。
 */
function findPhoto(p, id, slug, kind) {
  const v = s(p);
  if (/^(https?:|data:)/i.test(v)) return v;
  const dir = path.join(PHOTO_DIR, slug);
  if (v) {
    const tries = path.isAbsolute(v) ? [v] : [path.join(dir, v), path.join(ROOT, v)];
    const hit = tries.find(t => fs.existsSync(t));
    if (!hit) { warn(`${id}: 写真が見つかりません → ${v}（assets/photos/${slug}/ に置いてください）`); return ''; }
    return inlineImage(hit, id);
  }
  for (const ext of Object.keys(MIME)) {
    const auto = path.join(dir, kind + ext);
    if (fs.existsSync(auto)) return inlineImage(auto, id);
  }
  return '';
}

/** assets/photos/<slug>/face.* の実ファイルを探す。無ければ空文字 */
function photoFile(slug) {
  const dir = path.join(PHOTO_DIR, slug);
  for (const ext of Object.keys(MIME)) {
    const p = path.join(dir, 'face' + ext);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/**
 * YouTube のURLから動画IDを取り出す。
 * youtu.be/ID、youtube.com/watch?v=ID、/embed/ID、/shorts/ID、/live/ID、IDだけ に対応。
 */
function youtubeId(url) {
  const v = s(url);
  if (!v) return '';
  if (/^[\w-]{8,20}$/.test(v)) return v;
  const m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{8,20})/.exec(v);
  return m ? m[1] : '';
}

/* ================================================================== *
 * 4. 候補者データ → 表示用データ
 * ================================================================== */
function buildView(c, slug, logo) {
  const id = s(c.id);
  const b = c.basic || {};
  const info = c.info || {};
  const code = (s(b.countryCode) || 'XX').toUpperCase();

  const displayName = s(b.displayName) || '（表示名なし）';
  const flag = FLAGS[code] || FLAG_FALLBACK(code);

  /* 名前の下の1行（年齢・性別・国籍・現在地） */
  const facts = [];
  if (s(b.age)) facts.push(s(b.age) + '歳');
  if (s(b.gender)) facts.push(s(b.gender));
  const nat = s(b.nationality), loc = s(b.location);
  if (nat && !(loc && loc.indexOf(nat) === 0)) facts.push(nat + '国籍');
  if (loc) facts.push(/在住|在留|滞在|居住/.test(loc) ? loc : loc + ' 在住');

  /* 希望職種は名前の下に大きく出す。残り4項目は表に */
  const desiredJob = (norm(info.desiredJob) || {}).value || '';
  if (!desiredJob) warn(`${id}: 希望職種（info.desiredJob）が空です`);

  const infoRows = [];
  for (const [key, label] of INFO_ROWS) {
    const n = norm(info[key]);
    if (n) infoRows.push({ label, value: n.value, note: n.note });
  }

  /* インタビュー動画 */
  const v = c.video || {};
  const raw = s(v.youtube);
  const ytid = youtubeId(raw);
  if (!raw) warn(`${id}: インタビュー動画のURL（video.youtube）が空です`);
  else if (!ytid) warn(`${id}: 動画URLからYouTubeのIDが読み取れません → ${raw}`);
  const video = ytid ? {
    embed: `https://www.youtube-nocookie.com/embed/${ytid}?rel=0`,
    watch: `https://youtu.be/${ytid}`,
    duration: s(v.duration),
    interviewer: s(v.interviewer) || `${COMPANY.person}（${COMPANY.corp} ${COMPANY.title}）`,
    note: s(v.note),
    topics: arr(v.topics)
  } : null;

  /* 顔写真 */
  const faceImg = findPhoto((c.photos || {}).face, id, slug, 'face');
  if (!faceImg) warn(`${id}: 顔写真がありません → assets/photos/${slug}/face.jpg を置いてください`);

  /* 問い合わせボタン（候補者IDを件名に入れたメールが立ち上がる） */
  const subject = `候補者ID ${id}（${displayName}）について`;
  const mailBody = [
    `${COMPANY.brand}　${COMPANY.person} 様`, '',
    `候補者ID ${id}（${displayName}）について、お問い合わせします。`, '',
    '御社名：',
    'ご担当者名：',
    'ご連絡先：', '',
    'ご希望（オンライン面接の申込／履歴書の請求／その他）：', ''
  ].join('\r\n');
  const mailto = `mailto:${COMPANY.mail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}`;

  /* 人材バンクの絞り込み用 */
  const residence = s(info.residence);
  if (residence && RESIDENCES.indexOf(residence) < 0) {
    warn(`${id}: 在留資格「${residence}」は決めた区分にありません。${RESIDENCES.join('／')} のいずれかにしてください`);
  }
  const fields = arr(info.fields);
  for (const f of fields) {
    if (FIELDS.indexOf(f) < 0) warn(`${id}: 分野「${f}」は決めた区分にありません。build.js の FIELDS をご確認ください`);
  }
  const jpCode = s(info.japaneseCode);
  if (jpCode && !JP_LEVELS.some(([k]) => k === jpCode)) {
    warn(`${id}: 日本語コード「${jpCode}」は決めた区分にありません。N1〜N5 か JFT にしてください`);
  }

  return {
    id,
    slug,
    draft: c.draft === true,
    inJapan: b.inJapan === true,
    residence,
    fields,
    jpCode,
    updated: s(c.updated),
    logo,
    company: COMPANY,
    displayName,
    flag,
    facts: facts.join('・'),
    nationality: s(b.nationality),
    desiredJob,
    infoRows,
    video,
    comment: s(c.comment),
    faceImg,
    mailto,
    buildDate: new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
  };
}

/* ================================================================== *
 * 5. メイン
 * ================================================================== */
function main() {
  for (const d of [DATA_DIR, OUT_DIR, PHOTO_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  for (const f of ['template.html', 'style.css', 'index.html', '404.html', 'bank.html', 'bank.css']) {
    if (!fs.existsSync(path.join(SRC_DIR, f))) {
      console.error(`エラー: src/${f} がありません。雛形ファイルを戻してください。`);
      process.exit(1);
    }
  }

  const logoPath = path.join(ASSET_DIR, 'logo.png');
  if (!fs.existsSync(logoPath)) {
    console.error('エラー: assets/logo.png がありません。ロゴ画像を置いてください。');
    process.exit(1);
  }
  const logo = inlineImage(logoPath, 'logo');

  const tplCandidate = fs.readFileSync(path.join(SRC_DIR, 'template.html'), 'utf8');
  const tplIndex = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC_DIR, 'style.css'), 'utf8').replace(/\s+$/, '');

  /* ご紹介終了の画面。存在しないURL（404）と、就職が決まった方のURLの両方で使います */
  const tplGone = fs.readFileSync(path.join(SRC_DIR, '404.html'), 'utf8');
  const goneBody = [
    `${COMPANY.brand}　${COMPANY.person} 様`, '',
    '候補者のご紹介について、お問い合わせします。', '',
    '御社名：', 'ご担当者名：', 'ご連絡先：', '',
    'ご希望の職種：', 'ご希望の勤務地：', 'ご希望の時期：', ''
  ].join('\r\n');
  const goneView = {
    css, logo, company: COMPANY,
    mailto: `mailto:${COMPANY.mail}?subject=${encodeURIComponent('候補者のご紹介について')}&body=${encodeURIComponent(goneBody)}`
  };

  const salt = loadSalt();
  const base = pagesBase();

  /* 配布済みURLの対応表（あれば優先） */
  let slugs = {};
  if (fs.existsSync(SLUG_FILE)) {
    try { slugs = JSON.parse(fs.readFileSync(SLUG_FILE, 'utf8')); }
    catch (e) { console.error('エラー: data/_slugs.json が壊れています。', e.message); process.exit(1); }
  }

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  if (!files.length) { console.error('data/ に候補者JSONがありません。'); process.exit(1); }

  const seen = new Map();
  const cards = [];
  const written = new Set();

  for (const f of files) {
    const full = path.join(DATA_DIR, f);
    let c;
    try { c = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { console.error(`エラー: ${f} のJSONが読めません → ${e.message}`); process.exit(1); }

    const id = s(c.id);
    if (!id) { console.error(`エラー: ${f} に "id" がありません。`); process.exit(1); }
    if (seen.has(id)) {
      console.error(`エラー: id "${id}" が ${seen.get(id)} と ${f} で重複しています。JSONをコピーしたときは id を変えてください。`);
      process.exit(1);
    }
    seen.set(id, f);

    const code = (s((c.basic || {}).countryCode) || 'xx').toLowerCase();
    if (!slugs[id]) slugs[id] = slugFor(code, id, salt);
    else if (slugs[id].indexOf(code + '-') !== 0) {
      warn(`${id}: 国コードを変えましたが、URL(${slugs[id]})は変更していません（配布済みURLを守るため）。`);
    }
    const slug = slugs[id];

    /* 写真フォルダ（無ければ作る。ここに face.jpg を置く） */
    const photoDir = path.join(PHOTO_DIR, slug);
    if (!fs.existsSync(photoDir)) {
      fs.mkdirSync(photoDir, { recursive: true });
      if (!IN_CI) console.log(`  作成: assets/photos/${slug}/  ← ${id} の顔写真 face.jpg はここに置いてください`);
    }

    const status = s(c.status) || ST_OPEN;
    if (status !== ST_OPEN && status !== ST_CLOSED) {
      console.error(`エラー: ${f} の "status" は「${ST_OPEN}」か「${ST_CLOSED}」にしてください（いまは「${status}」）`);
      process.exit(1);
    }

    const view = buildView(c, slug, logo);
    view.css = css;
    view.status = status;

    if (status === ST_CLOSED) {
      /* 就職が決まった方。URLは生かしたまま、ご紹介終了の画面に差し替えます */
      fs.writeFileSync(path.join(OUT_DIR, slug + '.html'), render(tplGone, goneView), 'utf8');
      written.add(slug + '.html');
      console.log(`  掲載終了: docs/c/${slug}.html  ← ${f}  (${view.displayName})`);
      continue;
    }

    const html = render(tplCandidate, view);
    fs.writeFileSync(path.join(OUT_DIR, slug + '.html'), html, 'utf8');
    written.add(slug + '.html');

    /* 外部サイトが一覧を作れるよう、顔写真を単体のファイルとしても書き出す */
    const src = photoFile(slug);
    let photoName = '';
    if (src) {
      photoName = slug + path.extname(src).toLowerCase();
      fs.copyFileSync(src, path.join(OUT_DIR, photoName));
      written.add(photoName);
    }

    const b = c.basic || {};
    const info = c.info || {};
    cards.push({
      id, slug, file: f,
      draft: view.draft,
      displayName: view.displayName,
      flag: view.flag,
      facts: view.facts,
      desiredJob: view.desiredJob || '—',
      japanese: (norm(info.japanese) || {}).value || '—',
      availableFrom: (norm(info.availableFrom) || {}).value || '—',
      hasFace: !!view.faceImg,
      hasVideo: !!view.video,
      updated: view.updated || '—',
      url: base ? `${base}c/${slug}.html` : '',
      /* 人材バンク用 */
      bank: {
        slug,
        href: `c/${slug}.html`,
        photo: photoName ? `c/${photoName}` : '',
        displayName: view.displayName,
        flag: view.flag,
        facts: view.facts,
        residence: view.residence,
        residenceLabel: RES_CARD[view.residence] || view.residence,
        desiredJob: view.desiredJob,
        locKey: view.inJapan ? 'jp' : 'abroad',
        nationality: s(b.nationality),
        fieldsAttr: view.fields.join(','),
        jpCode: view.jpCode,
        jpLabel: view.jpCode ? (view.jpCode === 'JFT' ? 'JFT-Basic 合格' : 'JLPT ' + view.jpCode) : '',
        stayLabel: (() => {
          const v = (norm(info.japanStay) || {}).value || '';
          const head = v.split('（')[0].trim();
          return head ? '日本で' + head : '';
        })(),
        areaLabel: (norm(info.workArea) || {}).value || ''
      },
      /* candidates.json 用 */
      feed: {
        id: slug,
        url: base ? `${base}c/${slug}.html` : '',
        photo: photoName && base ? `${base}c/${photoName}` : '',
        displayName: view.displayName,
        nationality: s(b.nationality),
        countryCode: (s(b.countryCode) || '').toUpperCase(),
        age: Number(s(b.age)) || null,
        gender: s(b.gender),
        location: s(b.location),
        desiredJob: view.desiredJob,
        visa: (norm(info.visa) || {}).value || '',
        japanese: (norm(info.japanese) || {}).value || '',
        japanStay: (norm(info.japanStay) || {}).value || '',
        experience: (norm(info.experience) || {}).value || '',
        workArea: (norm(info.workArea) || {}).value || '',
        availableFrom: (norm(info.availableFrom) || {}).value || '',
        hasVideo: !!view.video,
        updated: view.updated || ''
      }
    });

    console.log(`  生成: docs/c/${slug}.html  ← ${f}  (${view.displayName})`);
  }

  /* 対応表を記録として書き出す（手元のみ。GitHub Actions 上では書き込み先が残らないので省略） */
  if (!IN_CI) fs.writeFileSync(SLUG_FILE, JSON.stringify(slugs, null, 2) + '\n', 'utf8');

  /* 孤児HTML（元データが消えたページ）の扱い */
  const orphans = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.html') && !written.has(f));
  for (const o of orphans) {
    if (CLEAN || IN_CI) { fs.unlinkSync(path.join(OUT_DIR, o)); if (!IN_CI) console.log(`  削除: docs/c/${o}`); }
    else warn(`docs/c/${o} は元データがありません。消すなら node build.js --clean`);
  }

  /* 一覧ページ・robots.txt */
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), render(tplIndex, {
    logo, company: COMPANY,
    cards,
    count: cards.length,
    buildDate: new Date().toLocaleString('ja-JP')
  }), 'utf8');

  /* 外部サイト向けの一覧データ。下書きは載せません */
  const published = cards.filter(c => !c.draft).map(c => c.feed);
  fs.writeFileSync(path.join(DOCS_DIR, 'candidates.json'), JSON.stringify({
    _説明: '公開中の候補者一覧です。ホームページ側でこのファイルを読み込めば、候補者の追加・削除が自動で反映されます。下書きの候補者は含みません。',
    updated: new Date().toISOString(),
    count: published.length,
    candidates: published
  }, null, 2) + '\n', 'utf8');

  /* ------------------------------------------------------------------ *
   * 人材バンク（企業向けの一覧）
   * 絞り込みのボタンは、掲載中の候補者から自動で作ります。
   * 選択肢が1つしか無い行は、押す意味がないので出しません。
   * ------------------------------------------------------------------ */
  const bankCards = cards.filter(c => !c.draft).map(c => c.bank);

  const uniq = (vals) => vals.filter((v, i) => v && vals.indexOf(v) === i);
  const byOrder = (vals, order) => order.filter(o => vals.indexOf(o) >= 0);

  const locVals = uniq(bankCards.map(c => c.locKey));
  const rows = [];
  if (locVals.length > 1) {
    rows.push({ key: 'loc', label: '現在地', opts: [
      { v: 'jp', t: '日本国内' }, { v: 'abroad', t: '海外' }
    ].filter(o => locVals.indexOf(o.v) >= 0) });
  }
  const natVals = uniq(bankCards.map(c => c.nationality)).sort();
  if (natVals.length > 1) {
    rows.push({ key: 'nat', label: '国籍', opts: natVals.map(v => ({ v, t: v })) });
  }
  const resVals = byOrder(uniq(bankCards.map(c => c.residence)), RESIDENCES);
  if (resVals.length > 1) {
    rows.push({ key: 'res', label: '在留資格', opts: resVals.map(v => ({ v, t: RES_PILL[v] || v })) });
  }
  const fieldVals = byOrder(uniq([].concat(...bankCards.map(c => c.fieldsAttr.split(',')))), FIELDS);
  if (fieldVals.length > 1) {
    rows.push({ key: 'field', label: '分野', opts: fieldVals.map(v => ({ v, t: v })), note: true });
  }
  const jpVals = JP_LEVELS.filter(([k]) => bankCards.some(c => c.jpCode === k));
  if (jpVals.length > 1) {
    rows.push({ key: 'jp', label: '日本語', opts: jpVals.map(([v, t]) => ({ v, t })) });
  }
  rows.forEach((r, i) => { r._last = i === rows.length - 1; });

  /* 検索エンジンとSNS向けの情報。ドメインを移したら base が変わるだけで、全部が追従します */
  const bankUrl = base ? base + 'bank.html' : '';
  const ogpSrc = path.join(ASSET_DIR, 'ogp.png');
  let ogpUrl = '';
  if (fs.existsSync(ogpSrc)) {
    fs.copyFileSync(ogpSrc, path.join(DOCS_DIR, 'ogp.png'));
    ogpUrl = base ? base + 'ogp.png' : '';
  } else {
    warn('assets/ogp.png がありません。SNSで共有したときの画像が出ません');
  }

  const bankCss = fs.readFileSync(path.join(SRC_DIR, 'bank.css'), 'utf8').replace(/\s+$/, '');
  fs.writeFileSync(path.join(DOCS_DIR, 'bank.html'), render(
    fs.readFileSync(path.join(SRC_DIR, 'bank.html'), 'utf8'), {
      css: bankCss, logo, company: COMPANY,
      cards: bankCards,
      count: bankCards.length,
      hasCards: bankCards.length > 0,
      rows,
      residences: RESIDENCES,
      fields: FIELDS.join('／'),
      today: new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }),
      pageUrl: bankUrl,
      ogpUrl,
      seoTitle: '特定技能の人材バンク｜面談動画つきで外国人材をご紹介｜ガイコクジンコネクト',
      seoDesc: '介護・建設・宿泊・外食など、特定技能をはじめとする在留資格で日本での就職を希望する外国人材を掲載しています。'
             + '代表が一人ずつ面談した動画を、そのままご覧いただけます。愛知県大府市の株式会社Minobordo（ガイコクジンコネクト）が運営しています。'
    }), 'utf8');

  /* 存在しないURLを開いたときの画面 */
  fs.writeFileSync(path.join(DOCS_DIR, '404.html'), render(tplGone, goneView), 'utf8');

  /* ------------------------------------------------------------------ *
   * 検索エンジン向けの設定
   *
   * 人材バンク（bank.html）だけを検索に載せます。
   * 個別の候補者ページと社内用一覧は、各ページの noindex で除きます。
   * robots.txt で /c/ を通行止めにはしません。通行止めにすると
   * 検索エンジンがページを読めず、noindex の指示も読めなくなるためです。
   * ------------------------------------------------------------------ */
  fs.writeFileSync(path.join(DOCS_DIR, 'robots.txt'), [
    '# 人材バンク（/bank.html）だけを検索エンジンに載せています。',
    '# 個別の候補者ページ（/c/…）と社内用一覧（/index.html）は、',
    '# 各ページの noindex で検索結果から除いています。',
    'User-agent: *',
    'Allow: /',
    '',
    base ? `Sitemap: ${base}sitemap.xml` : '# Sitemap: （公開URLが決まると入ります）',
    ''
  ].join('\n'), 'utf8');

  /* サイトマップ。人材バンクだけを載せます */
  if (base) {
    const lastmod = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(DOCS_DIR, 'sitemap.xml'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  <url>',
      `    <loc>${base}bank.html</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      '    <changefreq>weekly</changefreq>',
      '    <priority>1.0</priority>',
      '  </url>',
      '</urlset>',
      ''
    ].join('\n'), 'utf8');
  }

  /* public/ に置いたファイルは、そのまま docs/ へコピーします。
     Google Search Console の所有権確認ファイルなどを置く場所です。 */
  const PUB_DIR = path.join(ROOT, 'public');
  if (fs.existsSync(PUB_DIR)) {
    for (const f of fs.readdirSync(PUB_DIR)) {
      if (f.startsWith('.')) continue;
      const src = path.join(PUB_DIR, f);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(DOCS_DIR, f));
        console.log(`  コピー: public/${f} → docs/${f}`);
      }
    }
  }
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '', 'utf8');

  console.log(`\n完了: ${cards.length}件を docs/c/ に出力しました。一覧は docs/index.html です。`);

  /* 企業に渡すURL */
  if (base) {
    console.log('\n--- 企業に渡すURL ---');
    for (const c of cards) console.log(`  ${c.displayName}${c.draft ? '（下書き）' : ''}: ${c.url}`);
    console.log(`  社内用一覧: ${base}`);
  } else {
    console.log('\n（GitHub に登録すると、ここに企業へ渡すURLが表示されます）');
  }

  /* GitHub Actions の画面にも同じ表を出す */
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = cards.map(c => `| ${c.displayName}${c.draft ? '（下書き）' : ''} | ${c.id} | ${c.url} |`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## 企業に渡すURL\n\n| 候補者 | id | URL |\n|---|---|---|\n${rows}\n\n社内用一覧: ${base}\n` +
      (warnings.length ? `\n### 確認してください\n\n${warnings.map(w => '- ' + w).join('\n')}\n` : ''), 'utf8');
  }

  if (warnings.length) {
    console.log('\n--- 確認してください ---');
    warnings.forEach(w => console.log('  ! ' + w));
  }
}

main();
