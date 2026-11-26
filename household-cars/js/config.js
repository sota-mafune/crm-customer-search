/*
 * 世帯の車ウィジェットの対応表（組織ごとに変わるのはこのファイルだけ）
 *
 * 画面と CRM の項目（api_name）の対応・上限をここにまとめる。
 * 秘密情報・組織の id・個人情報はここに書かない（公開して配信するため。組織の URL は実行時に SDK で読む）。
 */
var HOUSEHOLD_CARS_CONFIG = {
    // 連絡先（お客様）。ご家族の氏名を読むときだけ使う
    contact: {
        module: "Contacts",
        nameFields: ["Full_Name", "Last_Name"],   // 先頭から試し、CRM が受け付けなければ次へ
        nameField: "Full_Name"
    },

    // 家族（本人 → 家族のレコード。逆向きのレコードも別にある）
    family: {
        module: "Family",
        selfField: "Self",                    // 本人（Contacts への参照）
        memberField: "FamilyMember",          // 家族（顧客）（Contacts への参照。無いこともある）
        memberNameField: "FamilyMemberName",  // 家族の氏名（文字。家族（顧客）があるときは空のことが多い）
        relationField: "Relationship",        // 続柄（選択肢）
        certaintyField: "Certainty",          // 確かさ（選択肢）
        notFamily: "家族ではない",            // この確かさのレコードは外す（表示名）
        candidate: "候補（機械）"             // この確かさのご家族には「候補」と小さく添える（表示名）
    },

    // 車両（どちらも連絡先への参照を持つ）。顧客検索と同じ項目
    vehicles: [
        {
            key: "ittou",
            label: "一等書記官",
            module: "CustomModule10",
            nameField: "Name",           // 車名
            contactField: "field11",     // 顧客データ（Contacts への参照）
            plateFull: "field14",        // 登録番号（1つの文字）
            vinField: "field70",         // 車台番号
            deletedField: "field68",     // 車両削除日（date）。値の入った車は出さない
            deletedLabel: "車両削除日",
            carFields: { name: "Name", vin: "field70", first: "field10", shaken: "field62" }   // 初年度・満了日（車検満了日）
        },
        {
            key: "jumps",
            label: "JUMPS",
            module: "JUMPS",
            nameField: "Name",
            contactField: "field120",
            plateParts: ["field108", "field111", "field114", "field118"],   // 登録番号１〜４（地名・分類番号・かな・一連番号）
            vinField: "field56",
            deletedField: "field196",    // 管理停止日（text）。where には足さず、読んだ後に手元で外す
            deletedLabel: "管理停止日",
            deletedType: "text",
            carFields: { name: "Name", vin: "field56", first: "field55", shaken: "field82" }   // 初度登録・車検満了日
        }
    ],

    // 表の列。owner＝持ち主、src＝区分（上の label）、plate＝登録番号（組み立てる）、それ以外は各車両の carFields の項目。
    // type: "date" は YYYY/MM/DD で出す。並びは sortDate の列の近い順（今日以降の早い順 → 過ぎたものの新しい順 → 空）
    carTable: {
        columns: [
            { key: "owner", label: "持ち主" },
            { key: "src", label: "区分" },
            { key: "name", label: "車名" },
            { key: "shaken", label: "車検満了日", type: "date" },
            { key: "plate", label: "登録番号" },
            { key: "first", label: "初度登録" },
            { key: "vin", label: "車台番号" }
        ],
        sortDate: "shaken",
        soonMonths: 6            // 車検満了日が今日からこの月数以内の行を目立たせる
    },

    familyScanMax: 1000,     // 1人の家族のレコードを読む上限（200 件ずつ）
    carScanMax: 1000,        // 車を読む上限（モジュールごと・50 人ずつの1本あたり）
    inMax: 50,               // COQL の in に並べる数の上限（実測: 51 で LIMIT_EXCEEDED）
    parallel: 3,             // 同時に流す COQL の本数
    // 親の画面の URL が読めないときの CRM の入口
    crmOrigin: "https://crm.zoho.com"
};
