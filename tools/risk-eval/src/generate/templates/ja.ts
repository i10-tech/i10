import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("ja")

/** Japanese: polite (desu/masu) throughout, addressed to the name plus 様. */
export const JA: Template[] = [
  t(
    "password-reset",
    "consumer-friendly",
    [
      "{product} のパスワードを再設定してください",
      "{product} アカウントへのアクセスを回復する",
    ],
    [
      "{name} 様",
      "{product} アカウントのパスワード再設定のリクエストを受け付けました。",
      { cta: "パスワードを再設定する", url: "{link:reset}" },
      "このリンクの有効期限は {minutes} 分です。お心当たりがない場合は、このメールを無視してください。パスワードは変更されません。",
      "{product} がメールでパスワードをお尋ねすることはありません。",
    ],
  ),
  t(
    "email-verification",
    "dev-terse",
    ["{product} のメールアドレスを確認してください"],
    [
      "{name} 様、{product} へようこそ。",
      "アカウントを有効にするため、{email} がご本人のアドレスであることを確認してください。",
      { cta: "メールアドレスを確認する", url: "{link:verify}" },
      "リンクの有効期限は {hours} 時間です。アカウントを作成していない場合は、このメールを無視してください。",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    ["{product} の認証コード: {code}", "{product} のワンタイムコードをお送りします"],
    [
      "{name} 様",
      "ログイン用の認証コードは次のとおりです。",
      { code: "{code}" },
      "コードの有効期限は {minutes} 分です。他の人には絶対に教えないでください。{product} がメールや電話でコードをお尋ねすることはありません。",
      "ログインを試みていない場合は、このメールを無視してください。",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["{product} へのログインリンク"],
    [
      "{name} 様",
      "下のボタンを押すと、パスワードなしでログインできます。",
      { cta: "ログインする", url: "{link:magic}" },
      "リンクは1回のみ有効で、{minutes} 分で期限が切れます。お心当たりがない場合は、このメールを無視してください。",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    [
      "{product} アカウントへの新しいログインがありました",
      "セキュリティのお知らせ: 新しい端末からのログイン",
    ],
    [
      "{name} 様",
      "いつもと異なる端末から、アカウントへのログインを確認しました。",
      {
        rows: [
          ["端末", "{device}"],
          ["おおよその場所", "{location}"],
          ["日時", "{date} {time}"],
        ],
      },
      "ご本人の場合は、何もする必要はありません。お心当たりがない場合は、すぐにパスワードを変更してください。",
      { cta: "アカウントの安全を確認する", url: "{link:security}" },
      "{product} がメールでパスワードやコードをお尋ねすることはありません。",
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["{product} のパスワードが変更されました"],
    [
      "{name} 様",
      "アカウント ({email}) のパスワードが {date} に変更されました。",
      "ご本人による変更の場合、対応は不要です。お心当たりがない場合は、パスワードを再設定し、{support} までご連絡ください。",
      { cta: "パスワードを再設定する", url: "{link:reset}" },
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["{product} のお支払い領収書", "お支払い確認 {invoice}"],
    [
      "{name} 様",
      "お支払いありがとうございます。内容は次のとおりです。",
      {
        rows: [
          ["請求書番号", "{invoice}"],
          ["日付", "{date}"],
          ["プラン", "{plan}プラン（{period}払い）"],
          ["合計", "{amount}"],
        ],
      },
      { cta: "請求書をダウンロード", url: "{link:invoices}" },
      "このご請求についてご不明な点は、{support} までお問い合わせください。",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    ["{inviter} さんが {team} に招待しました", "{product} の {team} への招待"],
    [
      "こんにちは。",
      "{inviter} さんが、{product} の {team} チームへの参加に招待しています。",
      { cta: "招待を承諾する", url: "{link:invite}" },
      "招待の有効期限は {days} 日です。{inviter} さんにお心当たりがない場合は、このメールを無視してください。",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["{product} へようこそ", "{name} 様、{product} のアカウントを作成しました"],
    [
      "{name} 様",
      "{product} のアカウントをご利用いただけます。はじめに、次のことをおすすめします。",
      {
        list: [
          "プロフィールを設定する",
          "チームメンバーを招待する",
          "スタートガイドを読む",
        ],
      },
      { cta: "はじめる", url: "{link:start}" },
      "ご不明な点は {support} までご連絡ください。",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    [
      "セキュリティ警告: ログインをブロックしました",
      "ご確認ください: アカウントへの不審なアクセス",
    ],
    [
      "{name} 様",
      "{location} ({ip}) からのアカウントへのログイン試行をブロックしました。",
      "お心当たりがない場合は、{hours} 時間以内にパスワードを変更してください。",
      { cta: "アカウントを保護する", url: "{link:security}" },
      "{product} がメールや電話でパスワード、暗証番号、認証コードをお尋ねすることはありません。",
    ],
  ),
]
