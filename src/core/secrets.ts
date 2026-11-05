// API keys another app sends with a brief (POST chat `account: { kind: 'api-key', apiKey }`) live in memory for
// their turn only. Everything Kiln writes (core.log, the conversation logs, the watchdog, chat.json errors) passes
// through redact() first, so a key that turns up in an error message or a stderr tail is never written out.

/** Keys held right now, with how many turns hold each. */
const held = new Map<string, number>();

/** A turn starts holding a key (in memory). */
export function holdSecret(secret: string): void {
  held.set(secret, (held.get(secret) ?? 0) + 1);
}

/** The turn that held a key ended: Kiln forgets it. */
export function releaseSecret(secret: string): void {
  const n = (held.get(secret) ?? 0) - 1;
  if (n > 0) held.set(secret, n);
  else held.delete(secret);
}

/** Anthropic API keys, whoever's they are. */
const KEY_LIKE = /\bsk-ant-[A-Za-z0-9_-]{8,}/g;

/** The text with every key Kiln holds (and anything shaped like an Anthropic API key) replaced. */
export function redact(text: string): string {
  let out = text;
  for (const s of held.keys()) if (s.length >= 8 && out.includes(s)) out = out.split(s).join('[API key]');
  return out.replace(KEY_LIKE, '[API key]');
}
