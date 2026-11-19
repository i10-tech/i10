import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("es")

/** Spanish: tú for consumer and shop mail, usted for bank-style mail. */
export const ES: Template[] = [
  t(
    "password-reset",
    "consumer-friendly",
    [
      "Restablece tu contraseña de {product}",
      "Recupera el acceso a tu cuenta de {product}",
    ],
    [
      "Hola {first}:",
      "Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de {product}.",
      { cta: "Restablecer contraseña", url: "{link:reset}" },
      "El enlace caduca en {minutes} minutos. Si no lo solicitaste, puedes ignorar este correo y tu contraseña seguirá igual.",
      "{product} nunca te pedirá tu contraseña por correo electrónico.",
    ],
  ),
  t(
    "email-verification",
    "dev-terse",
    ["Confirma tu correo electrónico en {product}"],
    [
      "Hola {first}, te damos la bienvenida a {product}.",
      "Confirma que {email} es tu dirección para activar tu cuenta.",
      { cta: "Confirmar correo", url: "{link:verify}" },
      "El enlace es válido durante {hours} horas. Si no creaste una cuenta, ignora este mensaje.",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    [
      "{code} es su código de seguridad de {product}",
      "Su código de verificación de {product}",
    ],
    [
      "Estimado/a {name}:",
      "Su código de verificación es:",
      { code: "{code}" },
      "Caduca en {minutes} minutos. No lo comparta con nadie: {product} nunca se lo pedirá por correo, teléfono ni mensaje.",
      "Si no intentó iniciar sesión, ignore este mensaje.",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["Tu enlace para entrar a {product}"],
    [
      "Hola {first}:",
      "Pulsa el botón para iniciar sesión sin contraseña.",
      { cta: "Iniciar sesión", url: "{link:magic}" },
      "El enlace es de un solo uso y caduca en {minutes} minutos. Si no lo pediste, ignora este correo.",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    [
      "Nuevo inicio de sesión en su cuenta de {product}",
      "Aviso de seguridad: acceso desde un dispositivo nuevo",
    ],
    [
      "Estimado/a {name}:",
      "Hemos detectado un inicio de sesión en su cuenta desde un dispositivo que no habíamos visto antes.",
      {
        rows: [
          ["Dispositivo", "{device}"],
          ["Ubicación aproximada", "{location}"],
          ["Fecha y hora", "{date}, {time}"],
        ],
      },
      "Si fue usted, no tiene que hacer nada. Si no reconoce este acceso, cambie su contraseña de inmediato.",
      { cta: "Revisar la seguridad de mi cuenta", url: "{link:security}" },
      "{product} nunca le pedirá su contraseña ni códigos por correo electrónico.",
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["Tu contraseña de {product} ha cambiado"],
    [
      "Hola {first}:",
      "La contraseña de tu cuenta ({email}) se cambió el {date}.",
      "Si fuiste tú, no hace falta que hagas nada. Si no, restablece tu contraseña y escríbenos a {support}.",
      { cta: "Restablecer contraseña", url: "{link:reset}" },
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["Recibo de su pago a {product}", "Confirmación de pago {invoice}"],
    [
      "Estimado/a {name}:",
      "Gracias por su pago. Estos son los datos:",
      {
        rows: [
          ["Factura", "{invoice}"],
          ["Fecha", "{date}"],
          ["Plan", "{plan} (por {period})"],
          ["Total", "{amount}"],
        ],
      },
      { cta: "Descargar factura", url: "{link:invoices}" },
      "Si tiene alguna duda sobre este cobro, escríbanos a {support}.",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    [
      "{inviter} te ha invitado a {team}",
      "Invitación para unirte a {team} en {product}",
    ],
    [
      "Hola:",
      "{inviter} te ha invitado a unirte al equipo {team} en {product}.",
      { cta: "Aceptar invitación", url: "{link:invite}" },
      "La invitación caduca en {days} días. Si no conoces a {inviter}, puedes ignorar este correo.",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["Te damos la bienvenida a {product}", "¡Bienvenido/a a {product}, {first}!"],
    [
      "Hola {first}:",
      "Tu cuenta de {product} ya está lista. Para empezar, te sugerimos:",
      {
        list: [
          "Completar tu perfil",
          "Invitar a tu equipo",
          "Explorar la guía de inicio",
        ],
      },
      { cta: "Empezar", url: "{link:start}" },
      "Si necesitas ayuda, escríbenos a {support}.",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    [
      "Alerta de seguridad: se bloqueó un inicio de sesión",
      "Acción necesaria: actividad sospechosa en su cuenta",
    ],
    [
      "Estimado/a {name}:",
      "Hemos bloqueado un intento de inicio de sesión en su cuenta desde {location} ({ip}).",
      "Si no fue usted, cambie su contraseña en las próximas {hours} horas.",
      { cta: "Proteger mi cuenta", url: "{link:security}" },
      "{product} nunca le pedirá su contraseña, su PIN ni códigos por correo electrónico o por teléfono.",
    ],
  ),
]
