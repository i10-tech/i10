import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("de")

/** German: du for consumer, developer and shop mail, Sie for bank-style mail. */
export const DE: Template[] = [
  t(
    "password-reset",
    "consumer-friendly",
    [
      "Setze dein {product}-Passwort zurück",
      "So kommst du wieder in dein {product}-Konto",
    ],
    [
      "Hallo {first},",
      "wir haben eine Anfrage erhalten, das Passwort für dein {product}-Konto zurückzusetzen.",
      { cta: "Passwort zurücksetzen", url: "{link:reset}" },
      "Der Link ist {minutes} Minuten gültig. Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren, dein Passwort bleibt unverändert.",
      "{product} fragt dich nie per E-Mail nach deinem Passwort.",
    ],
  ),
  t(
    "email-verification",
    "dev-terse",
    ["Bestätige deine E-Mail-Adresse für {product}"],
    [
      "Hallo {first}, willkommen bei {product}.",
      "Bestätige, dass {email} deine Adresse ist, um dein Konto zu aktivieren.",
      { cta: "E-Mail bestätigen", url: "{link:verify}" },
      "Der Link ist {hours} Stunden gültig. Falls du kein Konto erstellt hast, ignoriere diese Nachricht.",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    [
      "{code} ist Ihr Sicherheitscode für {product}",
      "Ihr Bestätigungscode für {product}",
    ],
    [
      "Guten Tag {name},",
      "Ihr Bestätigungscode lautet:",
      { code: "{code}" },
      "Er ist {minutes} Minuten gültig. Geben Sie ihn an niemanden weiter: {product} fragt nie per E-Mail, Telefon oder SMS danach.",
      "Wenn Sie sich nicht anmelden wollten, ignorieren Sie diese Nachricht.",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["Dein Anmelde-Link für {product}"],
    [
      "Hallo {first},",
      "tippe auf die Schaltfläche, um dich ohne Passwort anzumelden.",
      { cta: "Anmelden", url: "{link:magic}" },
      "Der Link kann nur einmal verwendet werden und läuft nach {minutes} Minuten ab. Wenn du ihn nicht angefordert hast, ignoriere diese E-Mail.",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    [
      "Neue Anmeldung bei Ihrem {product}-Konto",
      "Sicherheitshinweis: Anmeldung von einem neuen Gerät",
    ],
    [
      "Guten Tag {name},",
      "wir haben eine Anmeldung in Ihrem Konto von einem bisher unbekannten Gerät festgestellt.",
      {
        rows: [
          ["Gerät", "{device}"],
          ["Ungefährer Ort", "{location}"],
          ["Datum und Uhrzeit", "{date}, {time}"],
        ],
      },
      "Wenn Sie das waren, müssen Sie nichts tun. Wenn Sie die Anmeldung nicht kennen, ändern Sie bitte sofort Ihr Passwort.",
      { cta: "Kontosicherheit prüfen", url: "{link:security}" },
      "{product} fragt Sie nie per E-Mail nach Ihrem Passwort oder nach Codes.",
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["Dein {product}-Passwort wurde geändert"],
    [
      "Hallo {first},",
      "das Passwort für dein Konto ({email}) wurde am {date} geändert.",
      "Wenn du das warst, musst du nichts tun. Falls nicht, setze dein Passwort zurück und schreibe uns an {support}.",
      { cta: "Passwort zurücksetzen", url: "{link:reset}" },
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["Beleg für Ihre Zahlung an {product}", "Zahlungsbestätigung {invoice}"],
    [
      "Guten Tag {name},",
      "vielen Dank für Ihre Zahlung. Hier die Details:",
      {
        rows: [
          ["Rechnung", "{invoice}"],
          ["Datum", "{date}"],
          ["Tarif", "{plan} (pro {period})"],
          ["Gesamtbetrag", "{amount}"],
        ],
      },
      { cta: "Rechnung herunterladen", url: "{link:invoices}" },
      "Bei Fragen zu dieser Abbuchung schreiben Sie bitte an {support}.",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    ["{inviter} hat dich zu {team} eingeladen", "Einladung zu {team} bei {product}"],
    [
      "Hallo,",
      "{inviter} hat dich eingeladen, dem Team {team} bei {product} beizutreten.",
      { cta: "Einladung annehmen", url: "{link:invite}" },
      "Die Einladung läuft in {days} Tagen ab. Wenn du {inviter} nicht kennst, kannst du diese E-Mail ignorieren.",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["Willkommen bei {product}", "{first}, dein {product}-Konto ist bereit"],
    [
      "Hallo {first},",
      "dein {product}-Konto ist startklar. Für den Einstieg empfehlen wir:",
      {
        list: [
          "Dein Profil vervollständigen",
          "Dein Team einladen",
          "Die Starthilfe lesen",
        ],
      },
      { cta: "Loslegen", url: "{link:start}" },
      "Brauchst du Hilfe? Schreib uns an {support}.",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    [
      "Sicherheitswarnung: Eine Anmeldung wurde blockiert",
      "Handlung erforderlich: verdächtige Aktivität in Ihrem Konto",
    ],
    [
      "Guten Tag {name},",
      "wir haben einen Anmeldeversuch bei Ihrem Konto von {location} ({ip}) blockiert.",
      "Wenn Sie das nicht waren, ändern Sie Ihr Passwort innerhalb von {hours} Stunden.",
      { cta: "Mein Konto schützen", url: "{link:security}" },
      "{product} fragt Sie nie per E-Mail oder Telefon nach Ihrem Passwort, Ihrer PIN oder Codes.",
    ],
  ),
]
