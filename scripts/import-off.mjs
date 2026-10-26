// Imports products sold in Malta, then the priority brands, from Open Food Facts into the catalogue.
// Slow on purpose (their limit is 10 searches a minute) and resumable: progress is kept in the
// database, so running it again carries on. node scripts/import-off.mjs [max calls, default 60]
import { connect, close } from '../src/db.js';
import { importMalta } from '../src/off.js';

connect();
const pages = Number(process.argv[2] || 60);
const result = await importMalta({ pages, log: (m) => console.log(m) });
console.log('@@RESULT@@' + JSON.stringify(result));
await close();
process.exit(0);
