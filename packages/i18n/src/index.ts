import IntlMessageFormat from 'intl-messageformat';
import en from '../messages/en.json' with { type: 'json' };
import it from '../messages/it.json' with { type: 'json' };

/**
 * One message catalog, shared by the server (notification templates), the
 * admin dashboard, and the embed widget.
 *
 * Keys are namespaced strings and the catalogs are plain ICU JSON, so adding a
 * message is one edit per locale and order is irrelevant. The system this
 * replaces used positional arrays — twelve files edited at the same index, and
 * a mis-ordered entry silently rendered the wrong text.
 *
 * `en` is the source of truth for the key set: every other locale's shape is
 * checked against it at compile time, so a missing translation is a type error
 * rather than a runtime fallback nobody notices.
 */

export const LOCALES = ['en', 'it'] as const;
export type Locale = (typeof LOCALES)[number];

export type MessageKey = keyof typeof en;

const catalogs = {
  en,
  // Typed against `en`, so removing or misspelling a key here fails the build.
  it: it satisfies Record<MessageKey, string>,
} satisfies Record<Locale, Record<MessageKey, string>>;

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Falls back to `en` for anything unrecognized, never throwing on user input. */
export function resolveLocale(value: string | null | undefined, fallback: Locale = 'en'): Locale {
  if (!value) return fallback;

  const lower = value.toLowerCase();
  if (isLocale(lower)) return lower;

  // Accept region-tagged forms like `it-IT` or an Accept-Language fragment.
  const base = lower.split('-')[0] ?? '';
  return isLocale(base) ? base : fallback;
}

export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * Formatters are compiled once per key and cached: ICU parsing is the
 * expensive part, and the outbox worker renders the same handful of messages
 * repeatedly.
 */
export function createTranslator(locale: Locale): Translator {
  const catalog = catalogs[locale];
  const cache = new Map<string, IntlMessageFormat>();

  return (key, params = {}) => {
    let formatter = cache.get(key);

    if (!formatter) {
      formatter = new IntlMessageFormat(catalog[key], locale);
      cache.set(key, formatter);
    }

    return String(formatter.format(params));
  };
}

export { en as enMessages, it as itMessages };
