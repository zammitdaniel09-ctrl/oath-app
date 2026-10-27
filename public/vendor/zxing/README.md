# ZXing reader (WebAssembly)

The live barcode scanner (`public/scan.js`) uses this only where the browser has no `BarcodeDetector`
for food barcodes, which today means iOS Safari. It is loaded with a dynamic `import()` the first time
it is needed and is not in the service worker's precache; the worker keeps a copy after that first use.

- Package: `zxing-wasm` 3.1.6, from npm (`npm pack zxing-wasm@3.1.6`, tarball sha1
  `472cb7d5426eb01844413c8f57c052cd2a65bc7c`). Source: https://github.com/Sec-ant/zxing-wasm
- Built from ZXing-C++ commit `2c3dcfeffa7878950a58c1703c86774a428b0c91`
  (https://github.com/zxing-cpp/zxing-cpp).
- Files, copied unchanged:
  - `reader/index.js` from `dist/es/reader/index.js`
  - `share.js` from `dist/es/share.js` (the reader imports it as `../share.js`)
  - `zxing_reader.wasm` from `dist/reader/zxing_reader.wasm`, SHA-256
    `5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e` (the same as the module's
    `ZXING_WASM_SHA256`)
- Licences: `LICENSE` (zxing-wasm, MIT) and `LICENSE-zxing-cpp` (ZXing-C++, Apache-2.0).

The module would fetch its `.wasm` from a CDN by default. `scan.js` points `locateFile` at
`/vendor/zxing/zxing_reader.wasm`, so nothing is fetched from anywhere but the app.

To update: `npm pack zxing-wasm@<version>` in a scratch folder outside the repository (it is not a
dependency in `package.json`), copy the same three files and both licences, and update this note.
