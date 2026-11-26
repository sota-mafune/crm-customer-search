/*
 * 世帯の車ウィジェット（Zoho CRM の連絡先の詳細画面の関連リストに置く外部ホストのウィジェット）。読むだけ（作成・更新はしない）
 *
 * 流れ:
 *   1. PageLoad で、開いている連絡先（ご本人）の id を受け取る
 *   2. 家族のモジュールで「本人＝この連絡先」のレコードを COQL で読む（200 件ずつ）。確かさが「家族ではない」のものは読んだ後に外す
 *      （where に != を入れると、確かさが空のレコードまで外れるかが分からないため、手元で外す）
 *   3. 家族（顧客）の連絡先 id を集める。家族（顧客）が無い（氏名だけの）ご家族は、車を探せないので人数だけ数えて表の下に出す
 *   4. 家族の氏名が空のご家族（逆向きのレコードなど）は、連絡先の氏名を id in (50 個ずつ) で読む
 *   5. ご本人＋ご家族の連絡先 id で、車両のモジュールごとに車を読む（参照の項目 in (50 個ずつ)）
 *   6. 1つの表に出す。並びは車検満了日が今日以降の早い順 → 過ぎたものの新しい順 → 満了日なし。満了日が近い（soonMonths 以内）行は色を付ける
 * 削除日（config の deletedField）の入った車は出さない。date の項目は where に「is null」を足し、読んだ後に手元でも外す。
 *   text の項目（deletedType: "text"）は where に足さず、select で読んで手元だけで外す（空白だけの値は「入っていない」として残す）。
 * 項目の対応は js/config.js（HOUSEHOLD_CARS_CONFIG）だけに書く。秘密情報・組織の id はここに書かない（実行時に SDK で読む）。
 */
(function () {
    "use strict";

    var CFG = window.HOUSEHOLD_CARS_CONFIG;
    var PAGE = 200;                 // COQL は1回 200 件まで
    var INIT_TIMEOUT_MS = 15000;

    var state = {
        tabBase: "",                // レコードを新しいタブで開く URL の頭（https://.../crm/{組織}/tab/）。読めなければ ""
        badCarCols: {},             // 表の列の項目を COQL が断った車両（key → true）。以後その車両は列の項目を読まない
        badDeleted: {},             // 削除日の項目を COQL が断った車両（key → エラーの文）。以後その車両は削除日で外さない（知らせる）
        badNameFields: {},          // COQL が断った氏名の項目
        seq: 0,                     // 読み込みの連番（遅れて返った古い結果を捨てる）
        started: false,
        entityId: ""
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
    // COQL の文字に入れる値。' と \ と % は文を壊すので除く（id は数字だけなので通常は何も除かれない）
    function lit(s) { return String(s).replace(/['\\%]/g, ""); }

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

    // CRM が「この問い合わせは受け付けない」と返したエラーか（項目が無い・使えない・権限が無い・文の誤り）。
    // このときだけ項目を外して流し直す。通信の失敗・回数の上限・CRM 側の一時的な失敗は、その回のエラーとして出す
    var PERMANENT = ["INVALID_QUERY", "SYNTAX_ERROR", "NO_PERMISSION", "INVALID_DATA", "NOT_SUPPORTED", "FEATURE_NOT_SUPPORTED",
        "NOT_ALLOWED", "INVALID_MODULE", "OAUTH_SCOPE_MISMATCH"];
    function errCode(e) {
        if (!e || typeof e !== "object") return "";
        return String(e.code || (e.data && e.data[0] && e.data[0].code) || "").toUpperCase();
    }
    function isPermanent(e) { return PERMANENT.indexOf(errCode(e)) !== -1; }

    // ---------------------------------------------------------------- 家族
    // 本人＝この連絡先の家族のレコードを読み、ご家族（連絡先につながっている方）と、つながっていない方の人数にまとめる。
    // 同じ連絡先が複数のレコードに出たら1人にまとめる（続柄・氏名は先に読めたもの。どれか1つでも確かさが「候補（機械）」以外なら候補と出さない）
    async function readFamily(selfId) {
        var F = CFG.family;
        var sel = ["id", F.memberField, F.memberNameField, F.relationField, F.certaintyField];
        var r = await coqlPaged(sel, F.module, "(" + F.selfField + " = '" + lit(selfId) + "')", CFG.familyScanMax);
        var members = [], byId = {}, unlinked = 0, records = 0;
        r.rows.forEach(function (row) {
            var cert = str(row[F.certaintyField]);
            if (cert === F.notFamily) return;
            var mid = idOnly(row[F.memberField]);
            if (mid === String(selfId)) return;     // 本人と同じ連絡先（つながりの誤り）は数えない
            records++;
            if (!mid) { unlinked++; return; }
            var m = byId[mid];
            if (!m) { m = byId[mid] = { id: mid, name: "", relation: "", candidate: true, order: members.length }; members.push(m); }
            if (!m.name) m.name = str(row[F.memberNameField]).trim();
            if (!m.relation) m.relation = str(row[F.relationField]);
            if (cert !== F.candidate) m.candidate = false;
        });
        return { members: members, unlinked: unlinked, records: records, more: r.more };
    }

    // 家族の氏名が空のご家族の氏名を、連絡先から読む（50 人ずつ）。Full_Name を断られたら Last_Name で読む
    async function readNames(members) {
        var need = members.filter(function (m) { return !m.name; }).map(function (m) { return m.id; });
        if (!need.length) return;
        var c = CFG.contact, byId = {};
        var fields = c.nameFields.filter(function (f) { return !state.badNameFields[f]; });
        var lastErr = null, got = null, field = "";
        for (var i = 0; i < fields.length && !got; i++) {
            var f = fields[i];
            try {
                got = await pool(chunks(need, CFG.inMax).map(function (ids) {
                    return function () { return coqlPaged(["id", f], c.module, "(id in " + inList(ids) + ")", PAGE); };
                }));
                field = f;
            } catch (e) {
                if (!isPermanent(e)) throw e;
                lastErr = e;
                state.badNameFields[f] = true;
            }
        }
        if (!got) throw lastErr || new Error("氏名を読める項目がありません");
        got.forEach(function (g) { g.rows.forEach(function (row) { byId[idOnly(row.id)] = str(row[field]); }); });
        members.forEach(function (m) { if (!m.name && byId[m.id]) m.name = byId[m.id]; });
    }

    // ---------------------------------------------------------------- 車両
    function vehicleSelect(v, useDel) {
        var cols = ["id", v.nameField, v.contactField, v.vinField];
        if (v.plateFull) cols.push(v.plateFull);
        (v.plateParts || []).forEach(function (p) { if (cols.indexOf(p) === -1) cols.push(p); });
        if (useDel && v.deletedField && cols.indexOf(v.deletedField) === -1) cols.push(v.deletedField);
        return cols;
    }
    function carSelect(v, useDel) {
        var cols = vehicleSelect(v, useDel), cf = v.carFields || {};
        Object.keys(cf).forEach(function (k) { if (cf[k] && cols.indexOf(cf[k]) === -1) cols.push(cf[k]); });
        return cols;
    }
    function hasCarExtras(v) {
        var base = vehicleSelect(v), cf = v.carFields || {};
        return Object.keys(cf).some(function (k) { return cf[k] && base.indexOf(cf[k]) === -1; });
    }
    // 削除日の入った車か。date（既定）: 値が無い（null・空の文字）なら残す。
    // text（deletedType: "text"）: null・空の文字・前後の U+0020 以下の文字を除いて空なら残し、それ以外（"-None-" も）は外す
    function textFilled(val) {
        if (val === null || val === undefined) return false;
        return String(val).replace(/^[\u0000- ]+|[\u0000- ]+$/g, "") !== "";
    }
    function isDeleted(v, row) {
        if (!v.deletedField) return false;
        if (v.deletedType === "text") return textFilled(row[v.deletedField]);
        return str(row[v.deletedField]) !== "";
    }
    function aliveWhere(v, where) {
        if (v.deletedType === "text") return where;
        return nest([where, v.deletedField + " is null"], "and");
    }
    function platePartsText(v, r) {
        if (v.plateFull) return str(r[v.plateFull]);
        return (v.plateParts || []).map(function (p) { return str(r[p]); }).filter(Boolean).join(" ");
    }

    // 車両の COQL。削除日の条件と表の列の項目を付けて流す。恒久的なエラーで断られたら、列の項目を外す → 削除日を外す → 両方外す の順に
    // 流し直し、通った形で外したものは以後その車両では使わない（列は空欄、削除日は外さずに出して知らせる）。どれも通らなければ最初のエラーを投げる
    async function vehicleQuery(v, where, cap, droppedCols) {
        var useX = !state.badCarCols[v.key] && hasCarExtras(v);
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

    // ご本人＋ご家族（owners: [{ id, ... }]）の車を、モジュールごと・50 人ずつ1本で読む
    async function readCars(owners, warn) {
        var ids = owners.map(function (o) { return o.id; }), byId = {}, cars = [], truncated = [];
        owners.forEach(function (o) { byId[o.id] = o; });
        var tasks = [], dropped = {};
        CFG.vehicles.forEach(function (v) {
            chunks(ids, CFG.inMax).forEach(function (part) {
                tasks.push(async function () {
                    var r = await vehicleQuery(v, "(" + v.contactField + " in " + inList(part) + ")", CFG.carScanMax, dropped);
                    if (r.more && truncated.indexOf(v.label) === -1) truncated.push(v.label);
                    var cf = v.carFields || {};
                    r.rows.forEach(function (row) {
                        var o = byId[idOnly(row[v.contactField])];
                        if (!o || isDeleted(v, row)) return;
                        var vals = {};
                        Object.keys(cf).forEach(function (k) { vals[k] = cf[k] ? str(row[cf[k]]) : ""; });
                        vals.src = v.label;
                        vals.plate = platePartsText(v, row);
                        cars.push({ id: idOnly(row.id), module: v.module, srcKey: v.key, name: str(row[v.nameField]), owner: o, vals: vals });
                    });
                });
            });
        });
        await pool(tasks);
        Object.keys(dropped).forEach(function (lb) {
            warn.push("CRM が表の一部の項目（" + lb + "）を受け付けなかったため、その車の列の一部を空欄にしています（" + dropped[lb] + "）。");
        });
        if (truncated.length) {
            warn.push("車が多いため、" + truncated.join("・") + "の車は一部だけ出しています（50 人ぶんで先頭 " + CFG.carScanMax + " 台まで読みました）。");
        }
        return cars;
    }

    // ---------------------------------------------------------------- 日付と並び
    function fmtDate(s) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        return m ? m[1] + "/" + m[2] + "/" + m[3] : s;
    }
    function iso(d) {
        return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    }
    // 今日から n か月後の日付（月末は繰り上がらないように、その月の最終日にそろえる）
    function addMonthsIso(n) {
        var d = new Date(), day = d.getDate();
        var t = new Date(d.getFullYear(), d.getMonth() + n, 1);
        var last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
        t.setDate(Math.min(day, last));
        return iso(t);
    }
    function dateRank(s, today) {
        var m = /^(\d{4}-\d{2}-\d{2})/.exec(s || "");
        if (!m) return [2, ""];
        return m[1] >= today ? [0, m[1]] : [1, m[1]];
    }
    function byCarTable(today) {
        var dk = CFG.carTable.sortDate, order = {};
        CFG.vehicles.forEach(function (v, i) { order[v.key] = i; });
        return function (a, b) {
            if (dk) {
                var ra = dateRank(a.vals[dk], today), rb = dateRank(b.vals[dk], today);
                if (ra[0] !== rb[0]) return ra[0] - rb[0];
                if (ra[1] !== rb[1]) return (ra[1] < rb[1] ? -1 : 1) * (ra[0] === 1 ? -1 : 1);
            }
            return (a.owner.order - b.owner.order) || (order[a.srcKey] - order[b.srcKey]) || byJa(a.name, b.name);
        };
    }
    // 車検満了日が今日から soonMonths か月以内（今日を含む）か。過ぎたものは入れない
    function isSoon(s, today, limit) {
        var m = /^(\d{4}-\d{2}-\d{2})/.exec(s || "");
        return !!m && m[1] >= today && m[1] <= limit;
    }

    // ---------------------------------------------------------------- 読み込みの本体
    async function load(selfId) {
        var warn = [];
        var self = { id: String(selfId), self: true, order: 0 };
        var fam = null;
        try {
            fam = await readFamily(selfId);
        } catch (e) {
            warn.push("ご家族を読めませんでした（" + errText(e) + "）。ご本人の車だけ出しています。");
        }
        if (fam && fam.more) warn.push("家族のレコードが多いため、先頭 " + CFG.familyScanMax + " 件だけ読みました。");
        var members = fam ? fam.members : [];
        if (members.length) {
            try { await readNames(members); } catch (e2) {
                warn.push("ご家族の氏名を読めませんでした（" + errText(e2) + "）。氏名の無い方は「ご家族」と出しています。");
            }
        }
        if (state.badNameFields[CFG.contact.nameField] && !state.badNameFields[CFG.contact.nameFields[1]]) {
            warn.push("CRM が「氏名」の項目を受け付けなかったため、ご家族の氏名は「姓」の項目で出しています。");
        }
        members.forEach(function (m, i) { m.order = i + 1; });
        var owners = [self].concat(members);
        var cars = await readCars(owners, warn);
        CFG.vehicles.forEach(function (v) {
            if (!state.badDeleted[v.key]) return;
            var dl = v.deletedLabel || v.deletedField;
            warn.push("CRM が「" + dl + "」の項目（" + v.label + "）を受け付けなかったため、" +
                v.label + "の車は" + dl + "の入ったものも外さずに出しています（" + state.badDeleted[v.key] + "）。");
        });
        cars.sort(byCarTable(iso(new Date())));
        return { cars: cars, members: members, familyOk: !!fam, familyRecords: fam ? fam.records : 0, unlinked: fam ? fam.unlinked : 0, warn: warn };
    }

    // ---------------------------------------------------------------- 画面
    function show(viewId) {
        ["view-message", "view-main"].forEach(function (id) { $(id).hidden = id !== viewId; });
    }
    function fatal(title, body) {
        $("message-title").textContent = title;
        $("message-body").textContent = body || "";
        show("view-message");
        resize();
    }
    function setNotice(kind, html) {
        var el = $("notice");
        if (!html) { el.hidden = true; el.innerHTML = ""; return; }
        el.className = "notice notice-" + kind;
        el.innerHTML = html;
        el.hidden = false;
    }
    function ownerHtml(o) {
        if (o.self) return "<span class='owner-self'>ご本人</span>";
        var h = "<span class='owner-name'>" + esc(o.name || "ご家族") + "</span>";
        if (o.relation) h += "<span class='owner-rel'>（" + esc(o.relation) + "）</span>";
        if (o.candidate) h += "<small class='cand' title='機械で見つけた候補で、まだ確かめていません'>候補</small>";
        return h;
    }

    function render(res) {
        if (res.warn.length) setNotice("warn", res.warn.map(esc).join("<br>"));
        else setNotice("", "");
        var linked = res.members.length;
        var familyNone = res.familyOk && res.familyRecords === 0;
        var s = (!res.familyOk || familyNone) ? "ご本人" : "ご本人＋ご家族 " + linked + " 人";
        $("status").textContent = s + "・車 " + res.cars.length + " 台";
        var h = "";
        if (familyNone) h += "<div class='family-none'>家族の登録はありません</div>";
        if (!res.cars.length) {
            h += "<div class='empty'>車はありません</div>";
        } else {
            var cols = CFG.carTable.columns, today = iso(new Date()), limit = addMonthsIso(CFG.carTable.soonMonths || 6);
            h += "<div class='car-scroll'><table class='car-table'><thead><tr>" +
                cols.map(function (col) { return "<th scope='col' data-col='" + esc(col.key) + "'>" + esc(col.label) + "</th>"; }).join("") +
                "</tr></thead><tbody>";
            res.cars.forEach(function (car) {
                var href = state.tabBase ? state.tabBase + encodeURIComponent(car.module) + "/" + encodeURIComponent(car.id) : "";
                var link = href ? "<a class='car-link' href='" + esc(href) + "' target='_blank' rel='noopener'>"
                    : "<a class='car-link' href='#' data-open='" + esc(car.id) + "' data-entity='" + esc(car.module) + "'>";
                var soon = isSoon(car.vals[CFG.carTable.sortDate], today, limit);
                h += "<tr class='car-row" + (soon ? " soon" : "") + (car.owner.self ? " own" : "") + "' title='この車両を開く'>" + cols.map(function (col) {
                    if (col.key === "owner") return "<td data-col='owner'>" + ownerHtml(car.owner) + "</td>";
                    var v = car.vals[col.key] || "";
                    if (v && col.type === "date") v = fmtDate(v);
                    var txt = esc(v);
                    // 区分の列に車両へのリンクを置く（キーボードでも開けるように）。行のどこを押しても同じリンクを開く
                    if (col.key === "src") txt = link + (txt || "開く") + "</a>";
                    return "<td data-col='" + esc(col.key) + "'>" + txt + "</td>";
                }).join("") + "</tr>";
            });
            h += "</tbody></table></div>";
            h += "<div class='legend'><span class='legend-soon'></span>車検満了日が " + esc(String(CFG.carTable.soonMonths || 6)) + " か月以内</div>";
        }
        if (res.unlinked) {
            h += "<div class='unlinked'>車を探せないご家族: " + res.unlinked + "人（お客様とつながっていません）</div>";
        }
        $("results").innerHTML = h;
        resize();
    }

    // 関連リストの枠の高さを中身に合わせる（SDK が受け付けなければ何もしない）
    function resize() {
        try {
            if (!window.ZOHO || !ZOHO.CRM || !ZOHO.CRM.UI || typeof ZOHO.CRM.UI.Resize !== "function") return;
            var h = Math.min(Math.max(document.documentElement.scrollHeight + 4, 160), 1200);
            var p = ZOHO.CRM.UI.Resize({ height: String(h) });
            if (p && typeof p.catch === "function") p.catch(function () {});
        } catch (e) { /* 何もしない */ }
    }

    async function run(selfId) {
        var seq = ++state.seq;
        show("view-main");
        setNotice("", "");
        $("status").textContent = "読み込んでいます…";
        $("results").innerHTML = "";
        var res;
        try {
            res = await load(selfId);
        } catch (e) {
            if (seq !== state.seq) return;
            $("status").textContent = "";
            setNotice("error", "車を読めませんでした（" + esc(errText(e)) + "）。画面を開き直してください。");
            resize();
            return;
        }
        if (seq !== state.seq) return;
        render(res);
    }

    // ---------------------------------------------------------------- 起動
    function entityIdOf(data) {
        if (!data) return "";
        var v = data.EntityId;
        if (Array.isArray(v)) v = v[0];
        return idOnly(v);
    }
    function boot() {
        var sdk = typeof window.ZOHO !== "undefined" && window.ZOHO && window.ZOHO.embeddedApp;
        var inFrame = false;
        try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
        if (!sdk || !inFrame) {
            fatal("CRM の中で開いてください", "この画面は Zoho CRM のお客様（連絡先）の詳細画面の関連リストで使います。");
            return;
        }
        var done = false;
        setTimeout(function () {
            if (!done) $("message-body").textContent = "CRM とつながるのに時間がかかっています。画面を開き直してください。";
        }, INIT_TIMEOUT_MS);
        // PageLoad は init より前に登録する（開いている連絡先の id が届く）
        ZOHO.embeddedApp.on("PageLoad", function (data) {
            var id = entityIdOf(data);
            done = true;
            if (!id) { fatal("お客様を読み取れませんでした", "お客様（連絡先）の詳細画面で開いてください。"); return; }
            state.entityId = id;
            var go = function () { run(id); };
            if (state.started) go();
            else readOrg().then(function () { state.started = true; go(); });
        });
        ZOHO.embeddedApp.init().catch(function (e) {
            done = true;
            fatal("CRM とつながりませんでした", errText(e));
        });
        $("results").addEventListener("click", function (e) {
            if (!e.target.closest) return;
            var a = e.target.closest("a");
            if (a && !a.hasAttribute("data-open")) return;    // ふつうのリンク（新しいタブ）はそのまま開かせる
            if (!a) {
                // 表の行: リンクの外を押しても、その行のリンク（車両のレコード）を開く
                var tr = e.target.closest("tr.car-row"), link = tr && tr.querySelector("a.car-link");
                if (link) { e.preventDefault(); link.click(); }
                return;
            }
            e.preventDefault();
            // 組織の URL が読めなかったときは、SDK でレコードを開く（新しいタブにはならない）
            var entity = a.getAttribute("data-entity");
            try { ZOHO.CRM.UI.Record.open({ Entity: entity, RecordID: a.getAttribute("data-open") }); }
            catch (x) { setNotice("error", "車両を開けませんでした（" + esc(errText(x)) + "）。"); }
        });
    }

    // 組織の情報: sandbox か（右上の表示）と、レコードを新しいタブで開く URL（{CRM の入口}/crm/{組織の domain_name}/tab/{モジュール}/{id}）
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
        // ホスト名が zoho.{com,jp,...} そのものか、そのサブドメインのときだけ使う
        var origin = /^https:\/\/([a-z0-9-]+\.)*zoho\.(com|jp|eu|in|com\.au|com\.cn|ca|sa)$/i.test(parent) ? parent : CFG.crmOrigin;
        state.tabBase = domain ? origin + "/crm/" + domain + "/tab/" : "";
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
