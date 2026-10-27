// The shared barcode check (public/barcode.js), used by the live scanner on the phone and by the photo
// reader and the catalogue lookup on the server. Pure functions: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validBarcode, lookupCode, upcEToA, barcodeVariants, digits } from '../public/barcode.js';

test('EAN-13: a right check digit passes, any other fails', () => {
  assert.equal(validBarcode('4006381333931'), true);
  assert.equal(validBarcode('4006381333931', 'ean_13'), true);
  assert.equal(validBarcode('5000000001231'), true);
  for (let d = 0; d <= 9; d += 1) if (d !== 1) assert.equal(validBarcode(`400638133393${d}`), false, `check digit ${d}`);
  // One misread bar in the middle breaks it too.
  assert.equal(validBarcode('4006381383931'), false);
  // Two neighbouring digits swapped (a common slip when typing).
  assert.equal(validBarcode('4006381339331'), false);
});

test('EAN-8 passes on its own rule', () => {
  assert.equal(validBarcode('96385074'), true);
  assert.equal(validBarcode('96385074', 'ean_8'), true);
  assert.equal(validBarcode('96385075'), false);
  assert.equal(validBarcode('96385074', 'ean_13'), false, 'the length must fit the format');
});

test('UPC-A passes, and is the same code as the EAN-13 with a zero in front', () => {
  assert.equal(validBarcode('036000291452'), true);
  assert.equal(validBarcode('036000291452', 'upc_a'), true);
  assert.equal(validBarcode('036000291453'), false);
  assert.equal(validBarcode('0036000291452', 'ean_13'), true);
  assert.equal(validBarcode('036000291452', 'ean_13'), false);
});

test('UPC-E opens out to its UPC-A, and is checked through it', () => {
  // Each rule for where the zeros go: last data digit 0-2, 3, 4 and 5-9.
  assert.equal(upcEToA('04252614'), '042100005264');
  assert.equal(upcEToA('01234565'), '012345000065');
  assert.equal(upcEToA('01234531'), '012300000451');
  assert.equal(upcEToA('01234543'), '012340000053');
  for (const c of ['04252614', '01234565', '01234531', '01234543']) assert.equal(validBarcode(c, 'upc_e'), true, c);
  assert.equal(upcEToA('21234565'), null, 'only number systems 0 and 1');
  assert.equal(validBarcode('04252614', 'upc_e'), true);
  assert.equal(validBarcode('04252615', 'upc_e'), false);
  assert.equal(validBarcode('04252614'), true, 'eight digits with no format: UPC-E counts');
  assert.equal(validBarcode('04252614', 'ean_8'), false, 'but it is not an EAN-8');
  assert.equal(validBarcode('042100005264', 'upc_a'), true);
});

test('GTIN-14 passes; wrong lengths, letters and empties never do', () => {
  assert.equal(validBarcode('04006381333931'), true);
  for (const bad of ['', '1234567', '400638133', '40063813339', '400638133393100', '4006381333931X', 'abcdefghijklm', null, undefined]) {
    assert.equal(validBarcode(bad), false, String(bad));
  }
  assert.equal(validBarcode('4006 3813 3393 1'), false, 'spaces are for the caller to strip');
  assert.equal(validBarcode('4006381333931', 'qr_code'), false, 'an unknown format is not a food code');
});

test('lookupCode: the code to ask the catalogue for, or null', () => {
  assert.equal(lookupCode(' 4006 3813 3393 1 '), '4006381333931');
  assert.equal(lookupCode('4006381333932'), null);
  assert.equal(lookupCode('96385074'), '96385074', 'eight digits that pass as EAN-8 stay EAN-8');
  assert.equal(lookupCode('04252614'), '042100005264', 'a UPC-E is looked up as its UPC-A');
  assert.equal(lookupCode('04252614', 'upc_e'), '042100005264');
  assert.equal(lookupCode('036000291452', 'upc_a'), '036000291452');
  assert.equal(lookupCode('12345'), null);
  assert.equal(digits('50-00 112'), '5000112');
});

test('barcodeVariants: the same code with or without leading zeros', () => {
  assert.deepEqual(barcodeVariants('036000291452').sort(), ['00036000291452', '0036000291452', '036000291452']);
  assert.ok(barcodeVariants('0036000291452').includes('036000291452'));
  assert.ok(barcodeVariants('4006381333931').includes('04006381333931'));
  assert.ok(!barcodeVariants('4006381333931').includes('400638133393'), 'never a digit cut off the end');
  assert.deepEqual(barcodeVariants(''), []);
});
