/*
 * 顧客検索ウィジェットの対応表（組織ごとに変わるのはこのファイルだけ）
 *
 * 画面の欄と CRM の項目（api_name）の対応・上限をここにまとめる。
 * 秘密情報・組織の id・個人情報はここに書かない（公開して配信するため。組織の URL は実行時に SDK で読む）。
 */
var CUSTOMER_SEARCH_CONFIG = {
    // 連絡先（お客様）
    contact: {
        module: "Contacts",
        // 氏名の部分一致に使う項目。先頭から試し、CRM が受け付けなければ次へ
        nameFields: ["Full_Name", "Last_Name"],
        nameField: "Full_Name",        // 画面に出す氏名（受け付けられなければ nameFields の次の項目で出す）
        nameLabels: { Full_Name: "氏名", Last_Name: "姓" },
        kanaField: "field4",           // フリガナ。半角カナ＋半角空白で入っている
        noField: "field78",            // 顧客ＮＯ（数字。ゼロ埋めなし）
        // 電話として探す項目（上から順に画面に出す）。CRM が受け付けない項目は外して続ける
        phoneFields: [
            { api: "field117", label: "電話番号１" },
            { api: "field119", label: "電話番号２" },
            { api: "Phone", label: "電話番号" },
            { api: "Mobile", label: "携帯電話" },
            { api: "field6", label: "電話番号１（一等書記官）" },
            { api: "field79", label: "電話番号２（一等書記官）" }
        ]
    },

    // 車両（どちらも連絡先への参照を持つ）
    vehicles: [
        {
            key: "ittou",
            label: "一等書記官",
            module: "CustomModule10",
            nameField: "Name",           // 車名
            contactField: "field11",     // 顧客データ（Contacts への参照）
            // 登録番号は1つの文字（地名・分類番号・かな・一連番号を半角空白で区切る）。一連番号は plateNumber に別に入っている
            plateFull: "field14",
            plateNumber: "field17",      // 登録番号４桁（数字 1〜4 桁、ゼロ埋めなし）
            platePad: false,
            vinField: "field70",         // 車台番号
            // 削除日（date）。値の入った車は、持っている車・車の数・ナンバーと車台番号の当たりから外す。無い車両には書かない
            deletedField: "field68",
            deletedLabel: "車両削除日",
            // 車の表（carTable）の列に使う項目。区分・登録番号は組み立てるので書かない。無い列は空欄
            carFields: { name: "Name", vin: "field70", first: "field10", shaken: "field62" }   // 初年度・満了日（車検満了日）
        },
        {
            key: "jumps",
            label: "JUMPS",
            module: "JUMPS",
            nameField: "Name",
            contactField: "field120",
            // 登録番号が4つに分かれている（１=地名 ２=分類番号 ３=かな ４=一連番号）
            plateParts: ["field108", "field111", "field114", "field118"],
            plateNumber: "field118",
            platePad: true,              // 一連番号に4桁のゼロ埋め（例 0123）が少しあるので、両方の形で探す
            vinField: "field56",
            carFields: { name: "Name", vin: "field56", first: "field55", shaken: "field82" }   // 初度登録・車検満了日
        }
    ],

    // 「車 N 台」を開くと出る表（連絡先の関連リストに似せる。1行＝車1台）。
    // key: src＝区分（上の label）、plate＝登録番号（plateFull か plateParts をつなぐ）、それ以外は各車両の carFields の項目。
    // type: "date" は YYYY/MM/DD で出す。並びは当たった車 → sortDate の列の近い順（今日以降の早い順 → 過ぎたものの新しい順 → 空）
    carTable: {
        columns: [
            { key: "src", label: "区分" },
            { key: "name", label: "車名" },
            { key: "plate", label: "登録番号" },
            { key: "shaken", label: "車検満了日", type: "date" },
            { key: "first", label: "初度登録" },
            { key: "vin", label: "車台番号" }
        ],
        sortDate: "shaken"
    },

    maxPeople: 100,          // 画面に出すお客様の上限。超えたら先頭だけ出して知らせる
    contactScanMax: 400,     // 1つの問い合わせで読む連絡先の上限（200 件ずつ）。超えたら「多すぎる」と知らせる
    vehicleScanMax: 1000,    // 1つの欄で読む車両の上限（モジュールごと）
    carScanMax: 1000,        // 出すお客様の「持っている車」を読む上限（モジュールごと・50 人ずつの1本あたり）
    inMax: 50,               // COQL の in に並べる数の上限（実測: 51 で LIMIT_EXCEEDED）
    parallel: 3,             // 同時に流す COQL の本数（4 本で頭打ちの実測がある）
    vinMinLen: 4,            // 車台番号は 4 文字以上で探す
    // 親の画面の URL が読めないときの CRM の入口
    crmOrigin: "https://crm.zoho.com"
};
