// Barcodes on food packs: EAN-13, EAN-8, UPC-A and UPC-E (and the 14-digit GTIN they all fit inside).
// Shared by the phone's live scanner and the server's photo reader, so both trust exactly the same codes.
// A code is trusted only when its check digit adds up: one misread bar almost always breaks it.

export const digits = (code) => String(code ?? '').replace(/\D/g, '');

const LENGTH = { ean_13: 13, ean_8: 8, upc_a: 12 };

// GS1's check digit, the same for every length: counting from the right, the digits next to the check
// digit count three times, the ones between them once, and the check makes the sum a multiple of ten.
function checks(code) {
  if (!/^\d{8,14}$/.test(code)) return false;
  const body = code.slice(0, -1).split('').map(Number).reverse();
  const sum = body.reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code.at(-1));
}

// UPC-E squeezes a UPC-A code into 8 digits by dropping zeros; this puts them back. Its last data digit
// says where the zeros went. Only number systems 0 and 1 exist in UPC-E.
export function upcEToA(code) {
  const c = String(code ?? '');
  if (!/^[01]\d{7}$/.test(c)) return null;
  const [d1, d2, d3, d4, d5, d6] = c.slice(1, 7);
  let body;
  if ('012'.includes(d6)) body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${c[0]}${body}${c[7]}`;
}

// Whether a code's check digit is right. With a format (as a scanner reports it: ean_13, ean_8, upc_a,
// upc_e) only that format's rule applies; without one, any format of that length will do. Digits only:
// spaces and dashes are the caller's to strip.
export function validBarcode(code, format = null) {
  const c = String(code ?? '');
  if (!/^\d+$/.test(c)) return false;
  if (format === 'upc_e') {
    const a = upcEToA(c);
    return Boolean(a) && checks(a);
  }
  if (format) return c.length === LENGTH[format] && checks(c);
  if (c.length === 8) return checks(c) || validBarcode(c, 'upc_e');
  return [12, 13, 14].includes(c.length) && checks(c);
}

// The code to look a product up by, or null when it does not check out. UPC-E is opened out to the
// UPC-A it stands for, the form the food databases keep. Eight digits that pass as EAN-8 stay EAN-8,
// the common case in Europe.
export function lookupCode(code, format = null) {
  const c = digits(code);
  if (!validBarcode(c, format)) return null;
  if (format === 'upc_e' || (!format && c.length === 8 && !checks(c))) return upcEToA(c);
  return c;
}

// The same code as it may have been stored: a UPC-A (12 digits) is also an EAN-13 with a leading zero,
// and both are a GTIN-14 with one or two. Zeros in front never change a GS1 code.
export function barcodeVariants(code) {
  const c = digits(code);
  if (!c) return [];
  const core = c.replace(/^0+/, '');
  const out = new Set([c]);
  for (const n of [8, 12, 13, 14]) if (core && core.length <= n) out.add(core.padStart(n, '0'));
  return [...out];
}
