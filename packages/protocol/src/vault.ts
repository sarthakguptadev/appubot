import { z } from 'zod';
import { Id, Timestamp } from './entities';

/**
 * The Vault (Settings › Vault): logins, cards, contact info and API keys every bot can use without seeing the secrets.
 * Passwords, card numbers and security codes are typed into an app window by AppuBot itself (`agent.vault.fill`, via
 * computer use); API keys go to a private file the bot reads (`agent.vault.key`). Secrets are kept encrypted on this
 * computer and never go on the wire, except to the owner's own editor on request (`vault.reveal`).
 */

export const VaultKind = z.enum(['login', 'card', 'contact', 'apiKey']);
export type VaultKind = z.infer<typeof VaultKind>;

/** The secret fields each kind may hold. */
export const VaultSecretField = z.enum(['password', 'number', 'cvc', 'key']);
export type VaultSecretField = z.infer<typeof VaultSecretField>;
export const VAULT_SECRETS: Record<VaultKind, VaultSecretField[]> = {
  login: ['password'],
  card: ['number', 'cvc'],
  contact: [],
  apiKey: ['key'],
};

/** Contact info: not secret, so a bot may read it (to fill a form, write an address). */
export const VaultContactSchema = z.object({
  fullName: z.string().max(120).default(''),
  email: z.string().max(200).default(''),
  phone: z.string().max(60).default(''),
  company: z.string().max(120).default(''),
  address1: z.string().max(200).default(''),
  address2: z.string().max(200).default(''),
  city: z.string().max(120).default(''),
  region: z.string().max(120).default(''),
  postalCode: z.string().max(30).default(''),
  country: z.string().max(120).default(''),
});
export type VaultContact = z.infer<typeof VaultContactSchema>;

/** What's not secret about an item: what the lists show and what a bot may know. */
export const VaultItemFieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** login: the site or app it's for ("github.com", "Zoho Books") */
  site: z.string().max(200).optional(),
  /** login */
  username: z.string().max(200).optional(),
  /** card */
  cardholder: z.string().max(120).optional(),
  /** card: MM/YY */
  expiry: z.string().max(7).optional(),
  /** contact */
  contact: VaultContactSchema.optional(),
  /** apiKey: the environment variable it goes in (`OPENAI_API_KEY`) */
  envName: z.string().max(80).optional(),
  /** anything else the user wants bots to know about it */
  notes: z.string().max(1000).optional(),
});

export const VaultItemSchema = VaultItemFieldsSchema.extend({
  id: Id,
  kind: VaultKind,
  /** which secret fields are saved */
  secrets: z.array(VaultSecretField),
  /** card: its last four digits; apiKey: its last four characters (enough to tell keys apart) */
  hint: z.string().optional(),
  /** card: Visa, Mastercard… from its number */
  brand: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type VaultItem = z.infer<typeof VaultItemSchema>;

/** how many items one `vault.saveMany` takes (a password file is sent in runs of this many) */
export const VAULT_SAVE_MANY_MAX = 200;

/** `[A-Z_][A-Z0-9_]*`: an environment variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A card's brand from its number (first digits), for the list. */
export function cardBrand(number: string): string | undefined {
  const n = number.replace(/\D/g, '');
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'American Express';
  if (/^6(011|5)/.test(n)) return 'Discover';
  if (/^(60|65|81|82|508|353|356)/.test(n)) return 'RuPay';
  if (/^35/.test(n)) return 'JCB';
  if (/^3(0[0-5]|[68])/.test(n)) return 'Diners Club';
  return undefined;
}
