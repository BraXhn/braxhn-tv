// Projektets egna uppgifter. Länken "Stöd projektet" (frivillig donation via PayPal till utvecklaren, för kostnader och
// en riktig iOS-app) finns bara här. Webben får den som user.donateUrl i /api/status – aldrig för barnprofiler, inte när
// administratören slagit av "Visa länken Stöd projektet" och bara om adressen är https till paypal.com/paypal.me.
// Servern kontaktar aldrig PayPal; det sker först när någon själv klickar på länken. Tom sträng = ingen länk visas.
import { getSetting } from './db.js';

export const DONATE_URL = 'https://paypal.me/braxhn';

const HOSTS = new Set(['paypal.com', 'www.paypal.com', 'paypal.me', 'www.paypal.me']);

/** Adressen om den är en giltig https-adress till PayPal, annars null */
export function validDonateUrl(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  let u;
  try { u = new URL(s.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname.toLowerCase()) || u.port || u.username || u.password) return null;
  return u.href;
}

/** Den inbyggda länken. I testläge (NODE_ENV=test) kan DONATE_URL_OVERRIDE ersätta den – även med tom sträng. */
export function configuredDonateUrl() {
  const o = process.env.NODE_ENV === 'test' ? process.env.DONATE_URL_OVERRIDE : undefined;
  return validDonateUrl(o ?? DONATE_URL);
}

/** Inställningen "Visa länken Stöd projektet" (standard på) */
export const donateShown = () => getSetting('show_donate', '1') !== '0';

/** Länken för en inloggad användare, eller null (barnprofil, avslaget eller ingen giltig länk) */
export function donateUrlFor(user) {
  if (!user || user.max_age != null || !donateShown()) return null;
  return configuredDonateUrl();
}
