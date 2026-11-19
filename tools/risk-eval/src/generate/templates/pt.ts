import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("pt")

/** Portuguese, leaning Brazilian: você throughout. */
export const PT: Template[] = [
  t(
    "password-reset",
    "consumer-friendly",
    ["Redefina sua senha do {product}", "Recupere o acesso à sua conta {product}"],
    [
      "Olá, {first}!",
      "Recebemos um pedido para redefinir a senha da sua conta {product}.",
      { cta: "Redefinir senha", url: "{link:reset}" },
      "O link expira em {minutes} minutos. Se você não fez esse pedido, pode ignorar este e-mail: sua senha continuará a mesma.",
      "O {product} nunca pede sua senha por e-mail.",
    ],
  ),
  t(
    "email-verification",
    "dev-terse",
    ["Confirme seu e-mail no {product}"],
    [
      "Olá, {first}. Boas-vindas ao {product}.",
      "Confirme que {email} é o seu endereço para ativar a conta.",
      { cta: "Confirmar e-mail", url: "{link:verify}" },
      "O link vale por {hours} horas. Se você não criou uma conta, ignore esta mensagem.",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    [
      "{code} é o seu código de segurança do {product}",
      "Seu código de verificação do {product}",
    ],
    [
      "Prezado(a) {name},",
      "Seu código de verificação é:",
      { code: "{code}" },
      "Ele expira em {minutes} minutos. Não o compartilhe com ninguém: o {product} nunca solicita esse código por e-mail, telefone ou mensagem.",
      "Se você não tentou entrar na conta, ignore esta mensagem.",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["Seu link de acesso ao {product}"],
    [
      "Olá, {first}!",
      "Toque no botão para entrar sem senha.",
      { cta: "Entrar", url: "{link:magic}" },
      "O link só pode ser usado uma vez e expira em {minutes} minutos. Se não foi você quem pediu, ignore este e-mail.",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    [
      "Novo acesso à sua conta {product}",
      "Aviso de segurança: acesso de um novo dispositivo",
    ],
    [
      "Prezado(a) {name},",
      "Detectamos um acesso à sua conta a partir de um dispositivo que não reconhecemos.",
      {
        rows: [
          ["Dispositivo", "{device}"],
          ["Local aproximado", "{location}"],
          ["Data e hora", "{date}, {time}"],
        ],
      },
      "Se foi você, não é preciso fazer nada. Se não reconhece este acesso, altere sua senha imediatamente.",
      { cta: "Verificar a segurança da conta", url: "{link:security}" },
      "O {product} nunca pede sua senha nem códigos por e-mail.",
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["Sua senha do {product} foi alterada"],
    [
      "Olá, {first}!",
      "A senha da sua conta ({email}) foi alterada em {date}.",
      "Se foi você, não precisa fazer nada. Se não foi, redefina a senha e fale com a gente em {support}.",
      { cta: "Redefinir senha", url: "{link:reset}" },
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["Recibo do seu pagamento ao {product}", "Confirmação de pagamento {invoice}"],
    [
      "Prezado(a) {name},",
      "Obrigado pelo seu pagamento. Confira os dados:",
      {
        rows: [
          ["Fatura", "{invoice}"],
          ["Data", "{date}"],
          ["Plano", "{plan} (por {period})"],
          ["Total", "{amount}"],
        ],
      },
      { cta: "Baixar fatura", url: "{link:invoices}" },
      "Em caso de dúvida sobre esta cobrança, escreva para {support}.",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    [
      "{inviter} convidou você para {team}",
      "Convite para entrar em {team} no {product}",
    ],
    [
      "Olá!",
      "{inviter} convidou você para participar da equipe {team} no {product}.",
      { cta: "Aceitar convite", url: "{link:invite}" },
      "O convite expira em {days} dias. Se você não conhece {inviter}, pode ignorar este e-mail.",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["Boas-vindas ao {product}", "{first}, sua conta no {product} está pronta"],
    [
      "Olá, {first}!",
      "Sua conta no {product} já está pronta. Para começar, sugerimos:",
      {
        list: [
          "Completar seu perfil",
          "Convidar sua equipe",
          "Conhecer o guia de início",
        ],
      },
      { cta: "Começar", url: "{link:start}" },
      "Precisa de ajuda? Escreva para {support}.",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    [
      "Alerta de segurança: um acesso foi bloqueado",
      "Ação necessária: atividade suspeita na sua conta",
    ],
    [
      "Prezado(a) {name},",
      "Bloqueamos uma tentativa de acesso à sua conta a partir de {location} ({ip}).",
      "Se não foi você, altere sua senha nas próximas {hours} horas.",
      { cta: "Proteger minha conta", url: "{link:security}" },
      "O {product} nunca pede sua senha, seu PIN ou códigos por e-mail nem por telefone.",
    ],
  ),
]
