import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("fr")

/** French: vous throughout. */
export const FR: Template[] = [
  t(
    "password-reset",
    "consumer-friendly",
    [
      "Réinitialisez votre mot de passe {product}",
      "Retrouvez l'accès à votre compte {product}",
    ],
    [
      "Bonjour {first},",
      "Nous avons reçu une demande de réinitialisation du mot de passe de votre compte {product}.",
      { cta: "Réinitialiser le mot de passe", url: "{link:reset}" },
      "Ce lien expire dans {minutes} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe ne changera pas.",
      "{product} ne vous demandera jamais votre mot de passe par e-mail.",
    ],
  ),
  t(
    "email-verification",
    "dev-terse",
    ["Confirmez votre adresse e-mail pour {product}"],
    [
      "Bonjour {first}, bienvenue sur {product}.",
      "Confirmez que {email} est bien votre adresse pour activer votre compte.",
      { cta: "Confirmer l'adresse", url: "{link:verify}" },
      "Le lien est valable {hours} heures. Si vous n'avez pas créé de compte, ignorez ce message.",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    [
      "{code} est votre code de sécurité {product}",
      "Votre code de vérification {product}",
    ],
    [
      "Bonjour {name},",
      "Votre code de vérification est :",
      { code: "{code}" },
      "Il expire dans {minutes} minutes. Ne le communiquez à personne : {product} ne vous le demandera jamais par e-mail, par téléphone ou par SMS.",
      "Si vous n'avez pas tenté de vous connecter, ignorez ce message.",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["Votre lien de connexion à {product}"],
    [
      "Bonjour {first},",
      "Appuyez sur le bouton pour vous connecter sans mot de passe.",
      { cta: "Me connecter", url: "{link:magic}" },
      "Le lien ne peut servir qu'une fois et expire dans {minutes} minutes. Si vous ne l'avez pas demandé, ignorez cet e-mail.",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    [
      "Nouvelle connexion à votre compte {product}",
      "Alerte de sécurité : connexion depuis un nouvel appareil",
    ],
    [
      "Bonjour {name},",
      "Nous avons détecté une connexion à votre compte depuis un appareil que nous ne connaissions pas.",
      {
        rows: [
          ["Appareil", "{device}"],
          ["Lieu approximatif", "{location}"],
          ["Date et heure", "{date}, {time}"],
        ],
      },
      "Si c'était vous, vous n'avez rien à faire. Sinon, changez votre mot de passe immédiatement.",
      { cta: "Vérifier la sécurité de mon compte", url: "{link:security}" },
      "{product} ne vous demandera jamais votre mot de passe ni vos codes par e-mail.",
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["Votre mot de passe {product} a été modifié"],
    [
      "Bonjour {first},",
      "Le mot de passe de votre compte ({email}) a été modifié le {date}.",
      "Si c'était vous, il n'y a rien à faire. Sinon, réinitialisez-le et écrivez-nous à {support}.",
      { cta: "Réinitialiser le mot de passe", url: "{link:reset}" },
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["Reçu de votre paiement à {product}", "Confirmation de paiement {invoice}"],
    [
      "Bonjour {name},",
      "Merci pour votre paiement. Voici le détail :",
      {
        rows: [
          ["Facture", "{invoice}"],
          ["Date", "{date}"],
          ["Offre", "{plan} (par {period})"],
          ["Total", "{amount}"],
        ],
      },
      { cta: "Télécharger la facture", url: "{link:invoices}" },
      "Pour toute question sur ce prélèvement, écrivez à {support}.",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    [
      "{inviter} vous invite à rejoindre {team}",
      "Invitation à rejoindre {team} sur {product}",
    ],
    [
      "Bonjour,",
      "{inviter} vous invite à rejoindre l'équipe {team} sur {product}.",
      { cta: "Accepter l'invitation", url: "{link:invite}" },
      "L'invitation expire dans {days} jours. Si vous ne connaissez pas {inviter}, vous pouvez ignorer cet e-mail.",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["Bienvenue sur {product}", "{first}, votre compte {product} est prêt"],
    [
      "Bonjour {first},",
      "Votre compte {product} est prêt. Pour bien démarrer, nous vous suggérons de :",
      {
        list: [
          "Compléter votre profil",
          "Inviter votre équipe",
          "Lire le guide de démarrage",
        ],
      },
      { cta: "Commencer", url: "{link:start}" },
      "Besoin d'aide ? Écrivez-nous à {support}.",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    [
      "Alerte de sécurité : une connexion a été bloquée",
      "Action requise : activité suspecte sur votre compte",
    ],
    [
      "Bonjour {name},",
      "Nous avons bloqué une tentative de connexion à votre compte depuis {location} ({ip}).",
      "Si ce n'était pas vous, changez votre mot de passe dans les {hours} heures.",
      { cta: "Sécuriser mon compte", url: "{link:security}" },
      "{product} ne vous demandera jamais votre mot de passe, votre code PIN ni vos codes par e-mail ou par téléphone.",
    ],
  ),
]
