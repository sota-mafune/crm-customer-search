/*
 * 顧客検索ウィジェット（Zoho CRM の Web タブに置く外部ホストのウィジェット）。読むだけ（作成・更新はしない）
 *
 * 欄: 氏名・フリガナ・電話番号・顧客ＮＯ・ナンバー（登録番号）・車台番号。入れた欄の「どれか」に当たったお客様を出す（OR）。空の欄は使わない。
 * 探し方（欄ごとに別の COQL。広く当たる欄があっても、ほかの欄の当たりが上限で落ちないように）:
 *   氏名     … 連絡先の氏名を like '%語%'（空白で区切った語のうち長いもの1つ）→ 読んだ後に全部の語が入っているかを手元で確かめる
 *   フリガナ … 半角カナにそろえて like '%語%' → 同じく手元で確かめる（CRM の値は半角カナ＋半角空白）
 *   電話番号 … 数字だけにして、ありうる書き方（ハイフン無し・ハイフン入りの区切り方・+81）を in (...) で完全一致 → 手元で数字にそろえて比べる
 *   顧客ＮＯ … = で完全一致
 *   ナンバー … 末尾の一連番号（数字 1〜4 桁）で車両を = / in で引き、地名などが入っていれば手元で後ろ一致を確かめる
 *   車台番号 … like '%語%'（末尾の数字 6 桁など）→ ハイフンを除いて手元で確かめる
 * 車両で当たったら、参照先の連絡先の id を集めて id in (50 個ずつ) で読む。出すお客様の「持っている車」も 50 人ずつまとめて読む。
 * 「車 N 台 ▼」を開くと、その「持っている車」を関連リストに似た表で出す（列は config の carTable。同じ1本で読んだものを使い、開いたときに読み直さない）。
 * 削除日（config の deletedField）の入った車は、車両の COQL の where に「削除日 is null」を足して外し、読んだ後に手元でも外す。
 *   ナンバー・車台番号の当たりにも、持っている車・車の数にも、紐づいていない車の台数にも数えない。
 *
 * 項目の対応は js/config.js（CUSTOMER_SEARCH_CONFIG）だけに書く。秘密情報・組織の id はここに書かない（実行時に SDK で読む）。
 */
(function () {
    "use strict";

    var CFG = window.CUSTOMER_SEARCH_CONFIG;
    var PAGE = 200;                 // COQL は1回 200 件まで
    var INIT_TIMEOUT_MS = 15000;
    var WIDE_PX = 700;
    var CARS_SHOWN = 6;             // 1人に並べる車の数（超えた分は「ほか N 台」）

    var KIND_LABEL = { name: "氏名", kana: "フリガナ", phone: "電話", no: "顧客ＮＯ", plate: "ナンバー", vin: "車台番号" };
    var KIND_ORDER = ["name", "kana", "phone", "no", "plate", "vin"];

    var state = {
        user: null,
        recordBase: "",             // 連絡先を新しいタブで開く URL の頭（https://.../crm/{組織}/tab/Contacts/）。読めなければ ""
        tabBase: "",                // レコードを新しいタブで開く URL の頭（https://.../crm/{組織}/tab/）。車両にも使う。読めなければ ""
        badCarCols: {},             // 車の表の列の項目を COQL が断った車両（key → true）。以後その車両は列の項目を読まない
        badDeleted: {},             // 削除日の項目を COQL が断った車両（key → エラーの文）。以後その車両は削除日で外さない（知らせる）
        nameField: null,            // 氏名の部分一致に使えた項目（一度通ったら覚える）
        badNameFields: {},          // COQL が断った氏名の項目
        badPhoneFields: {},         // COQL が断った電話の項目
        seq: 0,                     // 検索の連番（遅れて返った古い結果を捨てる）
        busy: false
    };

    // ---------------------------------------------------------------- 小道具
    function $(id) { return document.getElementById(id); }
    function esc(v) {
        return String(v === null || v === undefined ? "" : v)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function str(v) {
        if (v === null || v === undefined) return "";
        if (typeof v === "object") return v.name !== undefined ? String(v.name) : (v.id !== undefined ? String(v.id) : "");
        var s = String(v);
        return s === "-None-" ? "" : s;
    }
    function idOnly(v) {
        if (v && typeof v === "object") v = v.id;
        return String(v === null || v === undefined ? "" : v).replace(/[^0-9]/g, "");
    }
    function errText(e) {
        if (!e) return "不明なエラー";
        if (typeof e === "string") return e.slice(0, 300);
        if (e.message && typeof e.message === "string") return (e.code ? e.code + ": " : "") + e.message.slice(0, 300);
        if (e.data && e.data[0] && (e.data[0].code || e.data[0].message)) return (e.data[0].code || "") + " " + (e.data[0].message || "");
        if (e.code) return String(e.code);
        try { return JSON.stringify(e).slice(0, 300); } catch (x) { return String(e); }
    }
    function byJa(a, b) { return String(a).localeCompare(String(b), "ja"); }
    // COQL の文字に入れる値。' と \ は文を壊すので除く（氏名などに入ることはまず無い）。like の % も除く
    function lit(s) { return String(s).replace(/['\\%]/g, ""); }

    // ---------------------------------------------------------------- 正規化
    // 全角の英数・記号を半角に、全角空白を半角空白に
    function toHalfAscii(s) {
        return String(s || "").replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
            .replace(/\u3000/g, " ");
    }
    // ひらがな → カタカナ
    function hiraToKata(s) {
        return String(s || "").replace(/[\u3041-\u3096]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0x60); });
    }
    // カタカナ → ひらがな（ナンバーのかなは、ひらがなでそろえる）
    function kataToHira(s) {
        return String(s || "").replace(/[\u30A1-\u30F6]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
    }
    var FULL_KANA = "ァアィイゥウェエォオカキクケコサシスセソタチッツテトナニヌネノハヒフヘホマミムメモャヤュユョヨラリルレロワヲンー・";
    var HALF_KANA = ["ｧ", "ｱ", "ｨ", "ｲ", "ｩ", "ｳ", "ｪ", "ｴ", "ｫ", "ｵ", "ｶ", "ｷ", "ｸ", "ｹ", "ｺ", "ｻ", "ｼ", "ｽ", "ｾ", "ｿ",
        "ﾀ", "ﾁ", "ｯ", "ﾂ", "ﾃ", "ﾄ", "ﾅ", "ﾆ", "ﾇ", "ﾈ", "ﾉ", "ﾊ", "ﾋ", "ﾌ", "ﾍ", "ﾎ", "ﾏ", "ﾐ", "ﾑ", "ﾒ", "ﾓ",
        "ｬ", "ﾔ", "ｭ", "ﾕ", "ｮ", "ﾖ", "ﾗ", "ﾘ", "ﾙ", "ﾚ", "ﾛ", "ﾜ", "ｦ", "ﾝ", "ｰ", "･"];
    var VOICED = "ガギグゲゴザジズゼゾダヂヅデドバビブベボ", SEMI = "パピプペポ";
    var KANA_EXTRA = { "ヴ": "ｳﾞ", "ヮ": "ﾜ", "ヵ": "ｶ", "ヶ": "ｹ", "ヰ": "ｲ", "ヱ": "ｴ", "－": "ｰ", "ｰ": "ｰ" };
    // 全角カタカナ（とひらがな）→ 半角カタカナ。濁点・半濁点は ﾞ ﾟ に分ける
    function toHalfKana(s) {
        s = hiraToKata(s);
        var out = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), k;
            if (KANA_EXTRA[c]) out += KANA_EXTRA[c];
            else if ((k = FULL_KANA.indexOf(c)) !== -1) out += HALF_KANA[k];
            else if (VOICED.indexOf(c) !== -1) out += HALF_KANA[FULL_KANA.indexOf(String.fromCharCode(c.charCodeAt(0) - 1))] + "ﾞ";
            else if (SEMI.indexOf(c) !== -1) out += HALF_KANA[FULL_KANA.indexOf(String.fromCharCode(c.charCodeAt(0) - 2))] + "ﾟ";
            else if (c === "゛") out += "ﾞ";
            else if (c === "゜") out += "ﾟ";
            else out += c;
        }
        return out;
    }
    function words(s) { return String(s || "").split(/\s+/).filter(function (w) { return w !== ""; }); }
    function longest(ws) { return ws.slice().sort(function (a, b) { return b.length - a.length; })[0] || ""; }

    // 氏名: 英数・空白を半角に、空白を除いて比べる
    function nameKey(s) { return toHalfAscii(s).replace(/\s+/g, "").toUpperCase(); }
    // フリガナ: 半角カナにそろえ、空白を除いて比べる
    function kanaKey(s) { return toHalfKana(toHalfAscii(s)).replace(/\s+/g, "").toUpperCase(); }
    // 電話: 数字だけ。+81 で始まるものは 0 から始まる形に
    function phoneKey(s) {
        var t = toHalfAscii(s).replace(/[\s\-‐‑‒–—―−ー()（）.]/g, "");
        if (/^\+81/.test(t)) { t = t.slice(3); if (t.charAt(0) !== "0") t = "0" + t; }
        return t.replace(/[^0-9]/g, "");
    }
    // 電話の入力から、CRM に入っていうる書き方を並べる（ハイフン無し・ハイフン入り・+81）
    function phoneVariants(d) {
        var out = [d];
        if (d.charAt(0) === "0" && d.length >= 9) {
            out.push("+81" + d.slice(1));
            out.push("+81 " + d);       // 「+81 」の後ろに 0 から始まる番号が続く形（少数ある）
        }
        // ハイフン入り: 市外局番 2〜5 桁・次が 1〜4 桁・最後が 3〜4 桁（CRM の値は 3 つに区切った形が多い）
        for (var a = 2; a <= 5; a++) {
            for (var b = 1; b <= 4; b++) {
                var c = d.length - a - b;
                if (c < 3 || c > 4) continue;
                out.push(d.slice(0, a) + "-" + d.slice(a, a + b) + "-" + d.slice(a + b));
            }
        }
        return out.slice(0, CFG.inMax);
    }
    // 顧客ＮＯ: 半角にして空白を除く
    function noKey(s) { return toHalfAscii(s).replace(/\s+/g, ""); }
    // ナンバー: 半角英数・ひらがなにそろえ、空白・区切り（- ・ .）を除き、末尾の一連番号のゼロ埋めを外す
    function plateKey(s) {
        var t = kataToHira(toHalfAscii(s)).replace(/[\s\-・･.]/g, "");
        return t.replace(/(^|[^0-9])0+([1-9][0-9]{0,3})$/, "$1$2");
    }
    // 車台番号: 半角・大文字、空白とハイフンを除く
    function vinKey(s) { return toHalfAscii(s).toUpperCase().replace(/[\s\-‐−ー]/g, ""); }

    // ---------------------------------------------------------------- 入力 → 探す条件
    // 空白なしで入れた氏名・フリガナ（「山田太郎」）を、CRM の値の形（姓と名の間に空白: 「山田　太郎」「山田 太郎」）に合わせるための候補。
    // 区切る位置ごとに全角・半角の空白を入れた形と、空白なしの形を並べる（in の上限 50 個まで。長さ L で 2(L-1)+1 個）
    function spaceSplits(tok) {
        var out = [tok];
        for (var i = 1; i < tok.length && out.length < CFG.inMax; i++) {
            var a = tok.slice(0, i), b = tok.slice(i);
            if (/^[ﾞﾟ]/.test(b)) continue;          // 濁点・半濁点の前では区切らない
            out.push(a + "　" + b);
            if (out.length < CFG.inMax) out.push(a + " " + b);
        }
        return out;
    }
    // 空白なしの語の頭（部分一致の手がかり）。2 文字。濁点・半濁点が含まれれば 3 文字。語が短ければ使わない
    function headOf(tok) {
        var n = /[ﾞﾟ]/.test(tok.slice(1, 3)) ? 3 : 2;
        return tok.length > n ? tok.slice(0, n) : "";
    }
    // 氏名・フリガナの条件。空白で区切って入れたら、長い語1つで like（手元で全部の語を確かめる）。
    // 空白なしの1語なら、① 区切りの候補の in と語全体の like を or で1本（狭い）② 語の頭 2 文字の like を別の1本（広い。
    //   姓と名にまたがる途中までの入力「山田太」を拾うため）。②は候補が多すぎても、①で当たっていれば知らせない
    function textCrit(ws, keys) {
        var c = { server: lit(longest(ws)), keys: keys, exact: null, head: "" };
        if (!c.server) return null;
        if (ws.length === 1 && c.server.length >= 2) {
            c.exact = spaceSplits(c.server);
            c.head = lit(headOf(c.server));
        }
        return c;
    }

    // 戻り値: { crit: { kind: {...} }, errors: [文] }
    function buildCriteria(raw) {
        var crit = {}, errors = [];
        var nm = words(toHalfAscii(raw.name).trim());
        if (nm.length) {
            var nmServer = words(String(raw.name || "").replace(/\u3000/g, " ").trim()); // 送るのは打ったままの語（CRM の氏名は全角が多い）
            var cn = textCrit(nmServer, nm.map(nameKey));
            if (cn) crit.name = cn;
        }
        var kn = words(toHalfKana(toHalfAscii(raw.kana)).trim());
        if (kn.length) {
            var ck = textCrit(kn, kn.map(kanaKey));
            if (ck) crit.kana = ck;
        }
        if (String(raw.phone || "").trim()) {
            var d = phoneKey(raw.phone);
            if (d.length < 6) errors.push("電話番号は市外局番（携帯は 090 など）から入れてください。");
            else crit.phone = { digits: d, variants: phoneVariants(d) };
        }
        if (String(raw.no || "").trim()) {
            var n = lit(noKey(raw.no));
            if (n) crit.no = { value: n };
        }
        if (String(raw.plate || "").trim()) {
            var pk = plateKey(raw.plate), m = /([0-9]{1,4})$/.exec(pk);
            if (!m) errors.push("ナンバーは一連番号（末尾の 1〜4 桁の数字）まで入れてください（例: 1234 か 練馬500あ1234）。");
            else if (/^[0-9]{5,}$/.test(pk)) errors.push("ナンバーの一連番号は 4 桁までです（例: 1234）。");
            else crit.plate = { number: String(parseInt(m[1], 10)), key: pk, onlyNumber: pk === String(parseInt(m[1], 10)) };
        }
        if (String(raw.vin || "").trim()) {
            var vk = vinKey(raw.vin);
            if (vk.length < CFG.vinMinLen) errors.push("車台番号は " + CFG.vinMinLen + " 文字以上入れてください。");
            else {
                // CRM の値は「型式-番号」のハイフン入りが多い。送る語は、ハイフンをまたがない部分にする。
                // ハイフンを入れたら最後の区切りの後ろ（番号）。短すぎれば（3 文字未満）いちばん長い区切り。
                // ハイフンが無ければ末尾の数字（4 桁以上なら末尾 6 桁まで。型式の数字を巻き込まないように）
                var segs = toHalfAscii(raw.vin).toUpperCase().split(/[\s\-‐−ー]+/).filter(Boolean), server;
                if (segs.length > 1) server = segs[segs.length - 1].length >= 3 ? segs[segs.length - 1] : longest(segs);
                else {
                    var tail = /([0-9]+)$/.exec(vk);
                    server = tail && tail[1].length >= 4 ? (tail[1].length > 6 ? tail[1].slice(-6) : tail[1]) : vk;
                }
                crit.vin = { server: lit(server), key: vk };
            }
        }
        return { crit: crit, errors: errors };
    }

    // ---------------------------------------------------------------- COQL
    function isEmptyResponse(res) {
        if (res === null || res === undefined || res === "") return true;
        if (typeof res !== "object") return false;
        if (res.status === 204 || res.status === "204") return true;
        return Object.keys(res).length === 0;
    }
    // where は2つずつ括弧で入れ子にする（3つ以上を and/or で並べると SYNTAX_ERROR になる実測があるため）
    function nest(conds, op) {
        if (!conds.length) return "";
        var w = conds[0];
        for (var i = 1; i < conds.length; i++) w = "(" + w + " " + op + " " + conds[i] + ")";
        return conds.length === 1 ? "(" + w + ")" : w;
    }
    function inList(vals) { return "(" + vals.map(function (v) { return "'" + lit(v) + "'"; }).join(", ") + ")"; }
    // 200 件ずつ cap 件まで読む。{ rows, more }（more = cap で打ち切った）
    async function coqlPaged(select, module, where, cap) {
        var out = [], offset = 0;
        while (true) {
            var q = "select " + select.join(", ") + " from " + module + " where " + where + " order by id asc limit " + offset + ", " + PAGE;
            var res = await ZOHO.CRM.API.coql({ select_query: q });
            if (res && Array.isArray(res.data)) {
                out = out.concat(res.data);
                if (res.info && res.info.more_records) {
                    offset += PAGE;
                    if (offset >= cap) return { rows: out, more: true };
                    continue;
                }
                return { rows: out, more: false };
            }
            if (res && typeof res === "object" && (res.code || res.status === "error" || res.message)) throw res;
            if (offset === 0 && isEmptyResponse(res)) return { rows: out, more: false };
            throw new Error("CRM の応答が想定外の形でした（" + module + "、" + (offset / PAGE + 1) + " ページ目）");
        }
    }
    // 仕事を同時に CFG.parallel 本まで流す。1つでも失敗したら残りは流さずに失敗にする
    async function pool(tasks) {
        var results = new Array(tasks.length), next = 0, failed = null;
        async function worker() {
            while (!failed && next < tasks.length) {
                var k = next++;
                try { results[k] = await tasks[k](); } catch (e) { failed = failed || e; }
            }
        }
        var ws = [];
        for (var i = 0; i < Math.min(CFG.parallel || 3, tasks.length); i++) ws.push(worker());
        await Promise.all(ws);
        if (failed) throw failed;
        return results;
    }
    function chunks(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

    // ---------------------------------------------------------------- 連絡先・車両の項目
    var C = function () { return CFG.contact; };
    function contactSelect() {
        var c = C(), cols = ["id"];
        if (!state.badNameFields[c.nameField]) cols.push(c.nameField);
        c.nameFields.forEach(function (f) { if (cols.indexOf(f) === -1 && !state.badNameFields[f]) cols.push(f); });
        cols.push(c.kanaField, c.noField);
        c.phoneFields.forEach(function (p) { cols.push(p.api); });
        return cols;
    }
    // 車両を探すときの select。useDel なら削除日の項目も読む（手元でも外すため）
    function vehicleSelect(v, useDel) {
        var cols = ["id", v.nameField, v.contactField, v.vinField];
        if (v.plateFull) cols.push(v.plateFull);
        (v.plateParts || []).forEach(function (p) { cols.push(p); });
        if (cols.indexOf(v.plateNumber) === -1) cols.push(v.plateNumber);
        if (useDel && v.deletedField && cols.indexOf(v.deletedField) === -1) cols.push(v.deletedField);
        return cols;
    }
    // 持っている車を読むときの select（探すときの項目＋車の表の列の項目）。同じ1本で取る（開いたときに読み直さない）
    function carSelect(v, useDel) {
        var cols = vehicleSelect(v, useDel), cf = v.carFields || {};
        Object.keys(cf).forEach(function (k) { if (cf[k] && cols.indexOf(cf[k]) === -1) cols.push(cf[k]); });
        return cols;
    }
    // 削除日の入った車か（読んだ後の手元の守り。COQL の is null が効かなくても外す）。
    // 関数（現在の車を選ぶもの）と同じく「値が無い（null）」なら残す。空の文字も残す
    function isDeleted(v, row) { return !!v.deletedField && str(row[v.deletedField]) !== ""; }
    // where に「削除日が空」を足す（2つずつ括弧で入れ子）
    function aliveWhere(v, where) { return nest([where, v.deletedField + " is null"], "and"); }
    function hasCarExtras(v) {
        var base = vehicleSelect(v), cf = v.carFields || {};
        return Object.keys(cf).some(function (k) { return cf[k] && base.indexOf(cf[k]) === -1; });
    }
    function carTable() { return CFG.carTable || { columns: [], sortDate: "" }; }
    // 日付は YYYY/MM/DD（CRM の date は YYYY-MM-DD で返る。日時なら日付の部分だけ）
    function fmtDate(s) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        return m ? m[1] + "/" + m[2] + "/" + m[3] : s;
    }
    function todayIso() {
        var d = new Date();
        return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    }
    // 日付の近さ: 今日以降は早い順 → 過ぎたものは新しい順 → 空。[組, 比べる文字]
    function dateRank(s, today) {
        var m = /^(\d{4}-\d{2}-\d{2})/.exec(s || "");
        if (!m) return [2, ""];
        return m[1] >= today ? [0, m[1]] : [1, m[1]];
    }
    function byCarTable(today) {
        var dk = carTable().sortDate, order = {};
        CFG.vehicles.forEach(function (v, i) { order[v.key] = i; });
        return function (a, b) {
            if (a.hit !== b.hit) return a.hit ? -1 : 1;
            if (dk) {
                var ra = dateRank(a.vals[dk], today), rb = dateRank(b.vals[dk], today);
                if (ra[0] !== rb[0]) return ra[0] - rb[0];
                if (ra[1] !== rb[1]) return (ra[1] < rb[1] ? -1 : 1) * (ra[0] === 1 ? -1 : 1);
            }
            return (order[a.srcKey] - order[b.srcKey]) || byJa(a.name, b.name);
        };
    }
    function contactName(r) {
        var c = C(), v = str(r[c.nameField]);
        if (!v) c.nameFields.forEach(function (f) { if (!v) v = str(r[f]); });
        return v;
    }
    function platePartsText(v, r) {
        if (v.plateFull) return str(r[v.plateFull]);
        return (v.plateParts || []).map(function (p) { return str(r[p]); }).filter(Boolean).join(" ");
    }

    // 手元での当たりの判定（CRM で引いた候補を、入力の決まりで確かめ直す）
    function contactHits(r, crit) {
        var c = C(), hits = {};
        if (crit.name) {
            var keys = c.nameFields.concat([c.nameField]).map(function (f) { return nameKey(str(r[f])); });
            if (keys.some(function (k) { return k && crit.name.keys.every(function (w) { return k.indexOf(w) !== -1; }); })) hits.name = true;
        }
        if (crit.kana) {
            var kk = kanaKey(str(r[c.kanaField]));
            if (kk && crit.kana.keys.every(function (w) { return kk.indexOf(w) !== -1; })) hits.kana = true;
        }
        if (crit.phone && c.phoneFields.some(function (p) { return phoneKey(str(r[p.api])) === crit.phone.digits; })) hits.phone = true;
        if (crit.no && noKey(str(r[c.noField])) === crit.no.value) hits.no = true;
        return hits;
    }
    function vehicleHits(v, r, crit) {
        var hits = {};
        if (crit.plate) {
            var num = str(r[v.plateNumber]).replace(/^0+/, "");
            if (num === crit.plate.number) {
                if (crit.plate.onlyNumber) hits.plate = true;
                else {
                    var pk = plateKey(platePartsText(v, r));
                    if (pk && pk.slice(-crit.plate.key.length) === crit.plate.key) hits.plate = true;
                }
            }
        }
        if (crit.vin) {
            var vk = vinKey(str(r[v.vinField]));
            if (vk && vk.indexOf(crit.vin.key) !== -1) hits.vin = true;
        }
        return hits;
    }

    // ---------------------------------------------------------------- 検索の本体
    // CRM が「この問い合わせは受け付けない」と返したエラーか（項目が無い・使えない・権限が無い・文の誤り）。
    // このときだけ項目を外して続ける。通信の失敗・回数の上限・CRM 側の一時的な失敗は、その回のエラーとして出す（項目は外さない）
    var PERMANENT = ["INVALID_QUERY", "SYNTAX_ERROR", "NO_PERMISSION", "INVALID_DATA", "NOT_SUPPORTED", "FEATURE_NOT_SUPPORTED",
        "NOT_ALLOWED", "INVALID_MODULE", "OAUTH_SCOPE_MISMATCH"];
    function errCode(e) {
        if (!e || typeof e !== "object") return "";
        return String(e.code || (e.data && e.data[0] && e.data[0].code) || "").toUpperCase();
    }
    function isPermanent(e) { return PERMANENT.indexOf(errCode(e)) !== -1; }

    // 連絡先の COQL。断られたら（恒久的なエラー）、select から氏名の項目（Full_Name）を外してもう一度流す。
    // それで通れば、氏名の項目はこの画面を開いている間は使わない（ほかの欄の検索まで全部失敗するのを防ぐ）
    async function contactQuery(where, cap) {
        var c = C(), sel = contactSelect();
        try {
            return await coqlPaged(sel, c.module, where, cap);
        } catch (e) {
            if (!isPermanent(e) || sel.indexOf(c.nameField) === -1 || where.indexOf(c.nameField) !== -1) throw e;
            var r;
            try { r = await coqlPaged(sel.filter(function (f) { return f !== c.nameField; }), c.module, where, cap); }
            catch (e2) { throw e; }
            state.badNameFields[c.nameField] = true;
            return r;
        }
    }
    // 氏名・フリガナの1つの項目で探す（textCrit の①②）。{ rows, more（①が打ち切り）, softMore（②が打ち切り） }
    async function textQuery(field, tc) {
        if (!tc.exact) return contactQuery("(" + field + " like '%" + tc.server + "%')", CFG.contactScanMax);
        var a = await contactQuery(nest([field + " in " + inList(tc.exact), field + " like '%" + tc.server + "%'"], "or"), CFG.contactScanMax);
        var out = { rows: a.rows, more: a.more, softMore: false, exactRows: a.rows };
        if (tc.head) {
            var b = await contactQuery("(" + field + " like '%" + tc.head + "%')", CFG.contactScanMax);
            out.rows = out.rows.concat(b.rows);
            out.softMore = b.more;
        }
        return out;
    }

    // 1つの欄ぶんの連絡先の COQL（氏名は項目を順に試す。電話は全部まとめて → 断られたら1項目ずつ）
    async function searchContactsBy(kind, crit, warn) {
        var c = C();
        if (kind === "name") {
            // 前に通った項目から試す。CRM が受け付けなければ次の項目へ（受け付けなかった項目はこの画面を開いている間は使わない）
            var fields = c.nameFields.filter(function (f) { return !state.badNameFields[f]; });
            if (state.nameField && fields.indexOf(state.nameField) > 0) fields = [state.nameField].concat(fields.filter(function (f) { return f !== state.nameField; }));
            var lastErr = null;
            for (var i = 0; i < fields.length; i++) {
                try {
                    var r = await textQuery(fields[i], crit.name);
                    state.nameField = fields[i];
                    return r;
                } catch (e) {
                    if (!isPermanent(e)) throw e;
                    lastErr = e;
                    state.badNameFields[fields[i]] = true;
                }
            }
            throw lastErr || new Error("氏名で探せる項目がありません");
        }
        if (kind === "kana") return textQuery(c.kanaField, crit.kana);
        if (kind === "no") return contactQuery("(" + c.noField + " = '" + crit.no.value + "')", CFG.contactScanMax);
        if (kind === "phone") {
            var pf = c.phoneFields.filter(function (p) { return !state.badPhoneFields[p.api]; });
            if (!pf.length) throw new Error("電話番号で探せる項目がありません");
            var vals = inList(crit.phone.variants);
            try {
                return await contactQuery(nest(pf.map(function (p) { return p.api + " in " + vals; }), "or"), CFG.contactScanMax);
            } catch (eAll) {
                if (!isPermanent(eAll)) throw eAll;
                // まとめて断られたら1項目ずつ。断られた項目は外して続ける（この画面を開いている間は覚える）
                var rows = [], more = false, ok = 0;
                for (var k = 0; k < pf.length; k++) {
                    try {
                        var one = await contactQuery("(" + pf[k].api + " in " + vals + ")", CFG.contactScanMax);
                        rows = rows.concat(one.rows); more = more || one.more; ok++;
                    } catch (e1) {
                        if (!isPermanent(e1)) throw e1;
                        state.badPhoneFields[pf[k].api] = true;
                        warn.push("電話番号の項目「" + pf[k].label + "」では探せませんでした（" + errText(e1) + "）。ほかの電話番号の項目で探しています。");
                    }
                }
                if (!ok) throw eAll;
                return { rows: rows, more: more };
            }
        }
        throw new Error("想定外の欄: " + kind);
    }

    // 車両の COQL。削除日の条件（where に「削除日 is null」・select に削除日）と、wantExtras なら車の表の列の項目を付けて流す。
    // 恒久的なエラーで断られたら、列の項目を外す → 削除日を外す → 両方外す の順に流し直し、通った形で外したものは
    // 以後その車両では使わない（列は空欄、削除日は外さずに出して知らせる）。どれも通らなければ最初のエラーを投げる。
    // 外すかどうかは出発時の state で決める（同じ車両の塊が同時に走り、先の1本が印を立てても、この1本は自分で流し直す）
    async function vehicleQuery(v, where, cap, wantExtras, droppedCols) {
        var useX = !!wantExtras && !state.badCarCols[v.key] && hasCarExtras(v);
        var useD = !!v.deletedField && !state.badDeleted[v.key];
        var opts = [[useX, useD]];
        if (useX) opts.push([false, useD]);
        if (useD) opts.push([useX, false]);
        if (useX && useD) opts.push([false, false]);
        var first = null;
        for (var i = 0; i < opts.length; i++) {
            var x = opts[i][0], d = opts[i][1], r;
            try {
                r = await coqlPaged(x ? carSelect(v, d) : vehicleSelect(v, d), v.module, d ? aliveWhere(v, where) : where, cap);
            } catch (e) {
                if (!first) { if (!isPermanent(e)) throw e; first = e; continue; }
                if (!isPermanent(e)) throw first;
                continue;
            }
            if (useX && !x) { state.badCarCols[v.key] = true; if (droppedCols) droppedCols[v.label] = errText(first); }
            if (useD && !d) state.badDeleted[v.key] = errText(first);
            return r;
        }
        throw first;
    }

    async function searchVehiclesBy(v, kind, crit) {
        var where;
        if (kind === "plate") {
            var vals = [crit.plate.number];
            if (v.platePad) { var p4 = ("0000" + crit.plate.number).slice(-4); if (p4 !== crit.plate.number) vals.push(p4); }
            where = vals.length === 1 ? "(" + v.plateNumber + " = '" + vals[0] + "')" : "(" + v.plateNumber + " in " + inList(vals) + ")";
        } else {
            where = "(" + v.vinField + " like '%" + crit.vin.server + "%')";
        }
        return vehicleQuery(v, where, CFG.vehicleScanMax, false, null);
    }

    async function runSearch(crit) {
        var warn = [];
        var people = {};            // 連絡先 id → { row, hits: {kind:true}, carHits: {車両 id:true}, order }
        var order = 0;
        function person(id) { return people[id] || (people[id] = { id: id, row: null, hits: {}, carHits: {}, order: order++ }); }
        var unlinked = 0;
        var tasks = [];

        ["name", "kana", "phone", "no"].forEach(function (kind) {
            if (!crit[kind]) return;
            tasks.push(async function () {
                var r = await searchContactsBy(kind, crit, warn);
                if (r.more) warn.push(KIND_LABEL[kind] + "で当たるお客様が多すぎて、全部は読めませんでした（先頭 " + CFG.contactScanMax + " 件まで）。もっと詳しく入れてください。");
                r.rows.forEach(function (row) {
                    var id = idOnly(row.id);
                    if (!id) return;
                    var h = contactHits(row, crit);
                    if (!h[kind]) return;   // CRM では当たったが、入力の決まりでは当たらない（例: 氏名の語の一部しか入っていない）
                    var p = person(id);
                    p.row = row;
                    Object.keys(h).forEach(function (k) { p.hits[k] = true; });
                });
                // 空白なしの入力の頭 2 文字での部分一致（広い方）が打ち切られた。狭い方（姓名ちょうど・語全体）で当たっていれば知らせない
                var nExact = (r.exactRows || []).filter(function (row) { return contactHits(row, crit)[kind]; }).length;
                if (r.softMore && !nExact) warn.push(KIND_LABEL[kind] + "の頭の文字で当たるお客様が多すぎて、全部は確かめられませんでした。姓と名の間に空白を入れるか、フルネームで入れてください。");
            });
        });
        CFG.vehicles.forEach(function (v) {
            ["plate", "vin"].forEach(function (kind) {
                if (!crit[kind]) return;
                tasks.push(async function () {
                    var r = await searchVehiclesBy(v, kind, crit);
                    if (r.more) warn.push(KIND_LABEL[kind] + "で当たる車（" + v.label + "）が多すぎて、全部は読めませんでした（先頭 " + CFG.vehicleScanMax + " 台まで）。もっと詳しく入れてください" + (kind === "plate" ? "（例: 地名から入れる）" : "") + "。");
                    r.rows.forEach(function (row) {
                        if (isDeleted(v, row)) return;    // 削除日の入った車は当たりにも、紐づいていない台数にも数えない
                        var h = vehicleHits(v, row, crit);
                        if (!h[kind]) return;
                        var cid = idOnly(row[v.contactField]);
                        if (!cid) { unlinked++; return; }
                        var p = person(cid);
                        p.hits[kind] = true;
                        p.carHits[v.key + ":" + idOnly(row.id)] = true;
                    });
                });
            });
        });
        await pool(tasks);
        // 氏名の項目（Full_Name）を CRM が受け付けなかったときは、代わりの項目で探して・出していると知らせる
        var cc = C();
        if (state.badNameFields[cc.nameField]) {
            var alt = cc.nameFields.filter(function (f) { return f !== cc.nameField && !state.badNameFields[f]; })[0];
            var lb = cc.nameLabels || {};
            warn.push("CRM が「" + (lb[cc.nameField] || cc.nameField) + "」の項目を受け付けなかったため、" +
                (alt ? "「" + (lb[alt] || alt) + "」の項目で探して・出しています（氏名全体が入っていない方は、氏名では当たらないことがあります）。" : "氏名では探せません。"));
        }
        if (unlinked) warn.push("当たった車のうち " + unlinked + " 台は、お客様（連絡先）に紐づいていないため出していません。");

        // 上限を超えたら、当たった欄の多い方から（同じなら見つけた順に）先頭だけを出す
        var list = Object.keys(people).map(function (k) { return people[k]; });
        var over = list.length > CFG.maxPeople;
        list.sort(function (a, b) { return Object.keys(b.hits).length - Object.keys(a.hits).length || a.order - b.order; });
        var total = list.length;
        if (over) list = list.slice(0, CFG.maxPeople);

        // 車でだけ当たった方の連絡先を読む（50 人ずつ）
        var need = list.filter(function (p) { return !p.row; }).map(function (p) { return p.id; });
        if (need.length) {
            var got = await pool(chunks(need, CFG.inMax).map(function (ids) {
                return function () { return contactQuery("(id in " + inList(ids) + ")", PAGE); };
            }));
            var byId = {};
            got.forEach(function (g) { g.rows.forEach(function (row) { byId[idOnly(row.id)] = row; }); });
            var missing = 0;
            list.forEach(function (p) {
                if (p.row) return;
                if (byId[p.id]) { p.row = byId[p.id]; Object.keys(contactHits(p.row, crit)).forEach(function (k) { p.hits[k] = true; }); }
                else missing++;
            });
            if (missing) {
                list = list.filter(function (p) { return !!p.row; });
                warn.push("車の紐づき先のお客様のうち " + missing + " 人は読めませんでした（削除済み・見る権限が無いなど）。");
            }
        }

        // 持っている車（出すお客様だけ。モジュールごとに 50 人ずつ）
        var carsOk = true;
        if (list.length) {
            try { await readCars(list, warn); } catch (eCars) {
                carsOk = false;
                warn.push("持っている車を読めませんでした（" + errText(eCars) + "）。お客様の一覧だけ出しています。");
            }
        }
        // 削除日の項目を CRM が受け付けなかった車両（この画面を開いている間は毎回知らせる）
        CFG.vehicles.forEach(function (v) {
            if (!state.badDeleted[v.key]) return;
            warn.push("CRM が「" + (v.deletedLabel || v.deletedField) + "」の項目（" + v.label + "）を受け付けなかったため、" +
                v.label + "の車は削除日の入ったものも外さずに出しています（" + state.badDeleted[v.key] + "）。");
        });

        list.sort(function (a, b) {
            return Object.keys(b.hits).length - Object.keys(a.hits).length ||
                byJa(kanaKey(str(a.row[C().kanaField])), kanaKey(str(b.row[C().kanaField]))) ||
                byJa(contactName(a.row), contactName(b.row));
        });
        return { list: list, total: total, over: over, warn: warn, carsOk: carsOk, crit: crit };
    }

    // 持っている車を読む（モジュールごと・50 人ずつ1本）。車の表の列の項目も同じ1本で取る。
    // 列の項目を CRM が断ったら（恒久的なエラー）、探すときの項目だけでその1本を流し直し、以後その車両の列は空欄にする。
    // 削除日の入った車は where で外し、読んだ後にも手元で外す（車の数・短い並び・表のどれにも入れない）
    async function readCars(list, warn) {
        var ids = list.map(function (p) { return p.id; }), byId = {};
        list.forEach(function (p) { p.cars = []; p.carsTruncated = []; byId[p.id] = p; });
        var tasks = [], dropped = {};
        CFG.vehicles.forEach(function (v) {
            chunks(ids, CFG.inMax).forEach(function (part) {
                tasks.push(async function () {
                    var where = "(" + v.contactField + " in " + inList(part) + ")";
                    var r = await vehicleQuery(v, where, CFG.carScanMax, true, dropped);
                    if (r.more) part.forEach(function (id) { var p = byId[id]; if (p && p.carsTruncated.indexOf(v.label) === -1) p.carsTruncated.push(v.label); });
                    var cf = v.carFields || {};
                    r.rows.forEach(function (row) {
                        var p = byId[idOnly(row[v.contactField])];
                        if (!p || isDeleted(v, row)) return;
                        var rid = idOnly(row.id), key = v.key + ":" + rid, vals = {};
                        Object.keys(cf).forEach(function (k) { vals[k] = cf[k] ? str(row[cf[k]]) : ""; });
                        vals.src = v.label;
                        vals.plate = platePartsText(v, row);
                        p.cars.push({ id: rid, module: v.module, srcKey: v.key, name: str(row[v.nameField]), plate: vals.plate, src: v.label,
                            hit: !!p.carHits[key], vals: vals });
                    });
                });
            });
        });
        await pool(tasks);
        Object.keys(dropped).forEach(function (lb) {
            warn.push("CRM が車の表の一部の項目（" + lb + "）を受け付けなかったため、その車の列の一部を空欄にしています（" + dropped[lb] + "）。");
        });
        var sortTable = byCarTable(todayIso());
        list.forEach(function (p) {
            // 短い並び: 当たった車を先に。同じ車が両方のモジュールにあれば両方出す（どちらの写しかは小さく出す）
            p.cars.sort(function (a, b) { return (b.hit ? 1 : 0) - (a.hit ? 1 : 0) || byJa(a.name, b.name); });
            // 車の表: 当たった車 → 車検満了日の近い順（sortDate）→ 区分 → 車名
            p.carTable = p.cars.slice().sort(sortTable);
        });
    }

    // ---------------------------------------------------------------- 画面
    function show(viewId) {
        ["view-message", "view-search"].forEach(function (id) { $(id).hidden = id !== viewId; });
    }
    function fatal(title, body) {
        $("message-title").textContent = title;
        $("message-body").textContent = body || "";
        show("view-message");
    }
    function setNotice(kind, html) {
        var el = $("notice");
        if (!html) { el.hidden = true; el.innerHTML = ""; return; }
        el.className = "notice notice-" + kind;
        el.innerHTML = html;
        el.hidden = false;
    }
    function readInputs() {
        return { name: $("q-name").value, kana: $("q-kana").value, phone: $("q-phone").value, no: $("q-no").value, plate: $("q-plate").value, vin: $("q-vin").value };
    }

    // 検索している間は「検索」「クリア」を止め、Enter も受けない（結果が混ざらないように。終わるまで待ってもらう）
    function setBusy(on) {
        state.busy = on;
        $("search-btn").disabled = on;
        $("clear-btn").disabled = on;
    }

    async function onSearch() {
        if (state.busy) return;
        var b = buildCriteria(readInputs());
        var kinds = Object.keys(b.crit);
        setNotice("", "");
        if (b.errors.length) { setNotice("error", b.errors.map(esc).join("<br>")); $("results").innerHTML = ""; $("status").textContent = ""; return; }
        if (!kinds.length) { setNotice("warn", "どれか1つ以上の欄に入れてから検索してください。"); $("results").innerHTML = ""; $("status").textContent = ""; return; }
        var seq = ++state.seq;
        setBusy(true);
        $("status").textContent = "検索しています…（" + KIND_ORDER.filter(function (k) { return b.crit[k]; }).map(function (k) { return KIND_LABEL[k]; }).join("・") + "）";
        $("results").innerHTML = "";
        var res;
        try {
            res = await runSearch(b.crit);
        } catch (e) {
            if (seq !== state.seq) return;
            setBusy(false);
            $("status").textContent = "";
            setNotice("error", "検索できませんでした（" + esc(errText(e)) + "）。もう一度お試しください。続くときはタブを開き直してください。");
            return;
        }
        if (seq !== state.seq) return;
        setBusy(false);
        render(res);
    }

    function render(res) {
        var msgs = res.warn.slice();
        if (res.over) msgs.unshift("当たったお客様が " + res.total + " 人で、上限の " + CFG.maxPeople + " 人を超えました。先頭の " + CFG.maxPeople + " 人だけ出しています。もっと詳しく入れてください。");
        if (msgs.length) setNotice(res.over ? "error" : "warn", msgs.map(esc).join("<br>"));
        if (!res.list.length) {
            $("status").textContent = "";
            $("results").innerHTML = "<div class='empty'>当たるお客様はいませんでした。入れた値を確かめてください。</div>";
            return;
        }
        $("status").textContent = res.list.length + " 人" + (res.over ? "（" + res.total + " 人中）" : "");
        var c = C(), h = "";
        h += "<div class='row row-head' aria-hidden='true'><span>当たった欄</span><span>氏名・フリガナ</span><span>顧客ＮＯ</span><span>電話</span><span>持っている車</span></div>";
        res.list.forEach(function (p) {
            var r = p.row;
            var badges = KIND_ORDER.filter(function (k) { return p.hits[k]; }).map(function (k) { return "<span class='badge b-" + k + "'>" + esc(KIND_LABEL[k]) + "</span>"; }).join("");
            var seen = {}, phones = [];
            c.phoneFields.forEach(function (pf) {
                var v = str(r[pf.api]), k = phoneKey(v);
                if (!v || !k || seen[k]) return;
                seen[k] = true;
                phones.push("<span class='phone" + (p.hits.phone && res.crit.phone && res.crit.phone.digits === k ? " hit" : "") + "'>" + esc(v) + "</span>");
            });
            var cars = "";
            if (p.cars) {
                var shown = p.cars.slice(0, CARS_SHOWN);
                cars = shown.map(function (car) {
                    return "<span class='car" + (car.hit ? " hit" : "") + "' title='" + esc(car.src) + "'>" + esc(car.name || "（車名なし）") +
                        (car.plate ? " <span class='plate'>" + esc(car.plate) + "</span>" : "") + "</span>";
                }).join("");
                if (p.cars.length > CARS_SHOWN) cars += "<span class='more'>ほか " + (p.cars.length - CARS_SHOWN) + " 台</span>";
                if (!p.cars.length) cars = "<span class='none'>なし</span>";
                if (p.carsTruncated && p.carsTruncated.length) cars += "<span class='more'>（一部のみ）</span>";
            } else cars = "<span class='none'>—</span>";
            var href = state.recordBase ? state.recordBase + encodeURIComponent(p.id) : "";
            h += "<div class='person'>";
            h += (href ? "<a class='row' href='" + esc(href) + "' target='_blank' rel='noopener'" : "<a class='row' href='#' data-open='" + esc(p.id) + "' data-entity='" + esc(c.module) + "'") +
                " title='この連絡先を開く'>" +
                "<span class='c-hits'>" + badges + "</span>" +
                "<span class='c-name'><b>" + esc(contactName(r) || "（氏名なし）") + "</b><small>" + esc(str(r[c.kanaField])) + "</small></span>" +
                "<span class='c-no'><small class='lbl'>顧客ＮＯ</small>" + esc(str(r[c.noField])) + "</span>" +
                "<span class='c-phone'>" + (phones.join("") || "<span class='none'>なし</span>") + "</span>" +
                "<span class='c-cars'>" + cars + "</span>" +
                "</a>" + carPanel(p) + "</div>";
        });
        $("results").innerHTML = h;
    }

    // 「車 N 台 ▼」の開閉と、開くと出る車の表（連絡先の関連リストに似せる。1行＝車1台。初めは閉じておく）
    var panelSeq = 0;
    function carPanel(p) {
        if (!p.carTable) return "";
        var n = p.carTable.length;
        if (!n) return "<div class='car-bar'><span class='car-count none'>車 0 台</span></div>";
        var cols = carTable().columns, pid = "cars-" + (++panelSeq);
        var h = "<div class='car-bar'><button type='button' class='car-toggle' aria-expanded='false' aria-controls='" + pid + "'>" +
            "車 " + n + " 台 <span class='arr' aria-hidden='true'>▼</span></button></div>";
        h += "<div class='car-panel' id='" + pid + "' hidden><div class='car-scroll'><table class='car-table'><thead><tr>" +
            cols.map(function (col) { return "<th scope='col' data-col='" + esc(col.key) + "'>" + esc(col.label) + "</th>"; }).join("") +
            "</tr></thead><tbody>";
        p.carTable.forEach(function (car) {
            var href = state.tabBase ? state.tabBase + encodeURIComponent(car.module) + "/" + encodeURIComponent(car.id) : "";
            var link = href ? "<a class='car-link' href='" + esc(href) + "' target='_blank' rel='noopener'>"
                : "<a class='car-link' href='#' data-open='" + esc(car.id) + "' data-entity='" + esc(car.module) + "'>";
            h += "<tr class='car-row" + (car.hit ? " hit" : "") + "' title='この車両を開く'>" + cols.map(function (col, i) {
                var v = car.vals[col.key] || "";
                if (v && col.type === "date") v = fmtDate(v);
                var txt = esc(v);
                // 最初の列（区分）に車両へのリンクを置く（キーボードでも開けるように）。行のどこを押しても同じリンクを開く
                if (i === 0) txt = link + (txt || "開く") + "</a>";
                return "<td data-col='" + esc(col.key) + "'>" + txt + "</td>";
            }).join("") + "</tr>";
        });
        h += "</tbody></table></div>";
        if (p.carsTruncated && p.carsTruncated.length) {
            h += "<div class='car-note'>車が多いため、" + esc(p.carsTruncated.join("・")) + "の車は一部だけ出しています（50 人ぶんで先頭 " +
                esc(String(CFG.carScanMax)) + " 台まで読みました）。全部はお客様の画面の関連リストで見てください。</div>";
        }
        return h + "</div>";
    }
    function toggleCars(btn) {
        var panel = $(btn.getAttribute("aria-controls"));
        if (!panel) return;
        var open = panel.hidden;
        panel.hidden = !open;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        var arr = btn.querySelector(".arr");
        if (arr) arr.textContent = open ? "▲" : "▼";
    }
    function clearAll() {
        if (state.busy) return;    // 検索している間はクリアしない（ボタンも止めてある）
        ["q-name", "q-kana", "q-phone", "q-no", "q-plate", "q-vin"].forEach(function (id) { $(id).value = ""; });
        setNotice("", "");
        $("status").textContent = "";
        $("results").innerHTML = "";
        $("q-name").focus();
    }

    // ---------------------------------------------------------------- 起動
    function boot() {
        var sdk = typeof window.ZOHO !== "undefined" && window.ZOHO && window.ZOHO.embeddedApp;
        var inFrame = false;
        try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
        if (!sdk || !inFrame) {
            fatal("CRM の中で開いてください", "この画面は Zoho CRM の「顧客検索」タブの中で使います。CRM にログインして、タブから開いてください。");
            return;
        }
        var done = false;
        setTimeout(function () {
            if (!done) $("message-body").textContent = "CRM とつながるのに時間がかかっています。タブを開き直してください（作った直後は開き直すと動くことがあります）。";
        }, INIT_TIMEOUT_MS);
        ZOHO.embeddedApp.init().then(function () {
            done = true;
            return start();
        }).catch(function (e) {
            done = true;
            fatal("CRM とつながりませんでした", errText(e));
        });
    }

    async function start() {
        try {
            var u = await ZOHO.CRM.CONFIG.getCurrentUser();
            state.user = u && u.users && u.users[0];
        } catch (e) { state.user = null; }   // 検索には使わないので、読めなくても進む
        await readOrg();
        show("view-search");
        $("search-form").addEventListener("submit", function (e) { e.preventDefault(); onSearch(); });
        $("clear-btn").addEventListener("click", clearAll);
        $("results").addEventListener("click", function (e) {
            if (!e.target.closest) return;
            var tg = e.target.closest(".car-toggle");
            if (tg) { e.preventDefault(); toggleCars(tg); return; }
            var anyA = e.target.closest("a");
            if (anyA && !anyA.hasAttribute("data-open")) return;    // ふつうのリンク（新しいタブ）はそのまま開かせる
            var a = anyA;
            if (!a) {
                // 車の表の行: リンクの外を押しても、その行のリンク（車両のレコード）を開く
                var tr = e.target.closest("tr.car-row"), link = tr && tr.querySelector("a.car-link");
                if (link) { e.preventDefault(); link.click(); }
                return;
            }
            e.preventDefault();
            // 組織の URL が読めなかったときは、SDK でこの画面をレコードに切り替える（新しいタブにはならない）
            var entity = a.getAttribute("data-entity") || C().module;
            try { ZOHO.CRM.UI.Record.open({ Entity: entity, RecordID: a.getAttribute("data-open") }); }
            catch (x) { setNotice("error", (entity === C().module ? "連絡先" : "車両") + "を開けませんでした（" + esc(errText(x)) + "）。"); }
        });
        $("q-name").focus();
    }

    // 組織の情報: sandbox か（右上の表示）と、連絡先を新しいタブで開く URL（{CRM の入口}/crm/{組織の domain_name}/tab/Contacts/{id}）
    // 右上の表示は sandbox と判断できたときだけ出す。本番・判断できないときは出さない（2026-11-24）
    async function readOrg() {
        var type = "", domain = "";
        try {
            var o = await ZOHO.CRM.CONFIG.getOrgInfo();
            var org = o && (o.org ? o.org[0] : o);
            if (org && org.type) type = String(org.type).toLowerCase();
            if (!type && org && typeof org.sandbox !== "undefined") type = org.sandbox ? "sandbox" : "production";
            if (org && org.domain_name && /^[A-Za-z0-9_-]+$/.test(String(org.domain_name))) domain = String(org.domain_name);
        } catch (e) { /* 読めなければ URL で見る */ }
        var parent = "";
        try { parent = (window.location.ancestorOrigins && window.location.ancestorOrigins.length) ? window.location.ancestorOrigins[0] : ""; } catch (e) { parent = ""; }
        if (!parent) { try { parent = document.referrer ? new URL(document.referrer).origin : ""; } catch (e) { parent = ""; } }
        if (!type && /sandbox/i.test(parent)) type = "sandbox";
        var el = $("env-badge");
        if (type === "sandbox") {
            el.textContent = "sandbox";
            el.className = "env-badge env-sandbox";
            el.hidden = false;
        } else {
            el.textContent = "";
            el.hidden = true;
        }
        // CRM の入口は親の画面（crm.zoho.com / crmplus.zoho.com / sandbox など）。読めなければ config の既定
        // ホスト名が zoho.{com,jp,...} そのものか、そのサブドメイン（crm.zoho.com・crmplus.zoho.com・crmsandbox.zoho.com など）のときだけ使う
        var origin = /^https:\/\/([a-z0-9-]+\.)*zoho\.(com|jp|eu|in|com\.au|com\.cn|ca|sa)$/i.test(parent) ? parent : CFG.crmOrigin;
        state.tabBase = domain ? origin + "/crm/" + domain + "/tab/" : "";
        state.recordBase = state.tabBase ? state.tabBase + C().module + "/" : "";
    }

    // 入力欄の Enter はフォームの submit で検索になる
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
