// -----------------------------------------------------------------------------
// The texts of the connection status and of the test button. Every text is a
// { en, fr } object (setConnectionStatus refuses a plain string). Never a raw
// answer, never a credential.
// -----------------------------------------------------------------------------

import { ISO_ZONE, MAX_STATUS_LENGTH } from './constants.js';

const formatters = {
  en: new Intl.DateTimeFormat('en-US', {
    timeZone: ISO_ZONE,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }),
  fr: new Intl.DateTimeFormat('fr-FR', {
    timeZone: ISO_ZONE,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }),
};

/** A wall-clock instant in Central time, per language. */
export const at = (t, lang) => {
  if (!Number.isFinite(t)) return '?';
  const textOf = formatters[lang].format(new Date(t));
  return lang === 'fr' ? `${textOf} (heure du Texas)` : `${textOf} (Central time)`;
};

const cut = (s) => (s.length > MAX_STATUS_LENGTH ? `${s.slice(0, MAX_STATUS_LENGTH - 1)}…` : s);
const both = (make) => ({ en: cut(make('en')), fr: cut(make('fr')) });

const CONFIG_ERRORS = {
  username_missing: {
    en: 'Enter the user name (e-mail) of your ERCOT API Explorer account',
    fr: "Saisissez l'identifiant (e-mail) de votre compte ERCOT API Explorer",
  },
  username_invalid: {
    en: 'The user name holds a forbidden character',
    fr: "L'identifiant contient un caractère interdit",
  },
  password_missing: {
    en: 'Enter the password of your ERCOT API Explorer account',
    fr: 'Saisissez le mot de passe de votre compte ERCOT API Explorer',
  },
  password_invalid: {
    en: 'The password holds a forbidden character',
    fr: 'Le mot de passe contient un caractère interdit',
  },
  key_missing: {
    en: 'Enter the subscription key (Primary key) of your ERCOT API Explorer profile',
    fr: "Saisissez la clé d'abonnement (Primary key) de votre profil ERCOT API Explorer",
  },
  key_invalid: {
    en: 'The subscription key is not a valid key (letters and digits only)',
    fr: "La clé d'abonnement n'est pas une clé valide (caractères alphanumériques seulement)",
  },
  zones_missing: {
    en: 'Choose at least one load zone',
    fr: 'Choisissez au moins une zone de charge',
  },
  zones_invalid: {
    en: 'Unknown load zone: choose Houston, North, South or West',
    fr: 'Zone de charge inconnue : choisissez Houston, North, South ou West',
  },
};

const REASONS = {
  network: { en: 'ERCOT could not be reached', fr: "ERCOT n'a pas pu être joint" },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  rate: { en: 'too many requests (HTTP 429)', fr: 'trop de requêtes (HTTP 429)' },
  server: { en: 'ERCOT server error', fr: 'erreur du serveur ERCOT' },
  forbidden: {
    en: 'access denied (HTTP 403; ERCOT blocks requests from outside the USA)',
    fr: 'accès refusé (HTTP 403 ; ERCOT bloque les requêtes venant de hors des États-Unis)',
  },
  unauthorized: {
    en: 'the token was not accepted (HTTP 401)',
    fr: "le jeton n'a pas été accepté (HTTP 401)",
  },
  answer: {
    en: 'unreadable answer or unexpected format',
    fr: 'réponse illisible ou format inattendu',
  },
  http: { en: 'unexpected HTTP answer', fr: 'réponse HTTP inattendue' },
};

const REFUSED = {
  login: {
    en: 'ERCOT refused the user name or password. Fix them, or press the button to try again',
    fr: "ERCOT a refusé l'identifiant ou le mot de passe. Corrigez-les, ou pressez le bouton pour réessayer",
  },
  key: {
    en: 'ERCOT refused the subscription key. Fix it, or press the button to try again',
    fr: "ERCOT a refusé la clé d'abonnement. Corrigez-la, ou pressez le bouton pour réessayer",
  },
};

export const T = {
  configError: (code) => CONFIG_ERRORS[code] ?? CONFIG_ERRORS.username_missing,
  configUnreadable: {
    en: 'Gladys did not give the configuration: trying again',
    fr: "Gladys n'a pas donné la configuration : nouvel essai",
  },
  dataUnreadable: {
    en: '/data is unreadable: nothing is read until it is readable again',
    fr: "/data est illisible : rien n'est lu tant qu'il ne l'est pas redevenu",
  },
  dataUnwritable: {
    en: '/data is not writable: the read waits',
    fr: "/data n'est pas inscriptible : la lecture attend",
  },
  refused: (kind) => REFUSED[kind] ?? REFUSED.login,
  waiting: (next) =>
    both((l) =>
      l === 'fr' ? `Première lecture le ${at(next, l)}` : `First read on ${at(next, l)}`,
    ),
  failed: (reason, next) =>
    both((l) =>
      l === 'fr'
        ? `Lecture échouée (${(REASONS[reason] ?? REASONS.http).fr}). Prochain essai le ${at(next, l)}`
        : `Read failed (${(REASONS[reason] ?? REASONS.http).en}). Next try on ${at(next, l)}`,
    ),
  noPrice: (next) =>
    both((l) =>
      l === 'fr'
        ? `Aucun prix récent publié par ERCOT. Prochaine lecture le ${at(next, l)}`
        : `No recent price published by ERCOT. Next read on ${at(next, l)}`,
    ),
  ok: ({ latest, zones, partial, calendars = [] }) =>
    both((l) => {
      const list = zones.join(', ');
      let text =
        l === 'fr'
          ? `Prix temps réel lus (${list}), dernier intervalle ${at(latest, l)}`
          : `Real-time prices read (${list}), last interval ${at(latest, l)}`;
      // The calendars Gladys does not take, in a compact form after the price.
      for (const why of ['owned', 'refused']) {
        const zones = calendars
          .filter(([, w]) => w === why)
          .map(([key]) => key.replace('spot-ercot-rt-lz-', ''));
        if (zones.length === 0) continue;
        const list = zones.join(', ');
        text +=
          l === 'fr'
            ? `. Calendriers non alimentés (${why === 'owned' ? 'autre intégration' : 'refusés par Gladys'}) : ${list}`
            : `. Calendars not fed (${why === 'owned' ? 'other integration' : 'refused by Gladys'}): ${list}`;
      }
      if (!partial) return text;
      return l === 'fr'
        ? `${text} ; dernière lecture incomplète (${(REASONS[partial] ?? REASONS.http).fr})`
        : `${text}; last read incomplete (${(REASONS[partial] ?? REASONS.http).en})`;
    }),
  tooSoon: (next) =>
    both((l) =>
      l === 'fr'
        ? `Lecture déjà faite il y a peu. Prochaine lecture le ${at(next, l)}`
        : `Read a short while ago. Next read on ${at(next, l)}`,
    ),
  paused: (next) =>
    both((l) =>
      l === 'fr'
        ? `Lectures en pause après des erreurs, jusqu'au ${at(next, l)}`
        : `Reads paused after errors, until ${at(next, l)}`,
    ),
};

/** The button's report: the status text, prefixed. */
export const report = (status) =>
  both((l) => (l === 'fr' ? `État : ${status.fr}` : `Status: ${status.en}`));
