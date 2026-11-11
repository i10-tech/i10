import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("zh")

/** Simplified Chinese: 您 throughout. */
export const ZH: Template[] = [
  t(
    "password-reset",
    "consumer-friendly",
    ["重置您的 {product} 密码", "找回您的 {product} 账户"],
    [
      "{name}，您好：",
      "我们收到了重置您 {product} 账户密码的请求。",
      { cta: "重置密码", url: "{link:reset}" },
      "链接将在 {minutes} 分钟后失效。如果这不是您本人的操作，请忽略此邮件，您的密码不会改变。",
      "{product} 绝不会通过邮件向您索要密码。",
    ],
  ),
  t(
    "email-verification",
    "dev-terse",
    ["请确认您在 {product} 的邮箱"],
    [
      "{name}，欢迎使用 {product}。",
      "请确认 {email} 是您的邮箱地址，以激活账户。",
      { cta: "确认邮箱", url: "{link:verify}" },
      "链接 {hours} 小时内有效。如果您没有注册账户，请忽略此邮件。",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    ["您的 {product} 验证码：{code}", "{product} 登录验证码"],
    [
      "{name}，您好：",
      "您的登录验证码是：",
      { code: "{code}" },
      "验证码 {minutes} 分钟内有效。请勿告诉任何人，{product} 绝不会通过邮件、电话或短信向您索要验证码。",
      "如果您没有尝试登录，请忽略此邮件。",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["您的 {product} 登录链接"],
    [
      "{name}，您好：",
      "点击下方按钮即可免密码登录。",
      { cta: "登录", url: "{link:magic}" },
      "链接仅可使用一次，{minutes} 分钟后失效。如果不是您本人申请，请忽略此邮件。",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    ["您的 {product} 账户有新的登录", "安全提醒：新设备登录"],
    [
      "{name}，您好：",
      "我们检测到有人使用一台新设备登录了您的账户。",
      {
        rows: [
          ["设备", "{device}"],
          ["大致位置", "{location}"],
          ["时间", "{date} {time}"],
        ],
      },
      "如果是您本人操作，无需处理。如果您不认识此次登录，请立即修改密码。",
      { cta: "检查账户安全", url: "{link:security}" },
      "{product} 绝不会通过邮件向您索要密码或验证码。",
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["您的 {product} 密码已修改"],
    [
      "{name}，您好：",
      "您的账户（{email}）密码已于 {date} 修改。",
      "如果是您本人操作，无需处理。如果不是，请重置密码并联系 {support}。",
      { cta: "重置密码", url: "{link:reset}" },
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["{product} 付款收据", "付款确认 {invoice}"],
    [
      "{name}，您好：",
      "感谢您的付款，明细如下：",
      {
        rows: [
          ["发票号", "{invoice}"],
          ["日期", "{date}"],
          ["套餐", "{plan}（按{period}计费）"],
          ["合计", "{amount}"],
        ],
      },
      { cta: "下载发票", url: "{link:invoices}" },
      "如对本次扣款有疑问，请联系 {support}。",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    ["{inviter} 邀请您加入 {team}", "邀请您加入 {product} 上的 {team}"],
    [
      "您好：",
      "{inviter} 邀请您加入 {product} 上的 {team} 团队。",
      { cta: "接受邀请", url: "{link:invite}" },
      "邀请 {days} 天内有效。如果您不认识 {inviter}，请忽略此邮件。",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["欢迎使用 {product}", "{name}，您的 {product} 账户已就绪"],
    [
      "{name}，您好：",
      "您的 {product} 账户已经就绪。建议您从以下几步开始：",
      { list: ["完善个人资料", "邀请团队成员", "阅读新手指南"] },
      { cta: "开始使用", url: "{link:start}" },
      "如需帮助，请联系 {support}。",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    ["安全警告：已拦截一次登录", "需要您处理：账户出现可疑活动"],
    [
      "{name}，您好：",
      "我们拦截了一次来自 {location}（{ip}）的账户登录尝试。",
      "如果不是您本人操作，请在 {hours} 小时内修改密码。",
      { cta: "保护我的账户", url: "{link:security}" },
      "{product} 绝不会通过邮件或电话向您索要密码、PIN 或验证码。",
    ],
  ),
]
