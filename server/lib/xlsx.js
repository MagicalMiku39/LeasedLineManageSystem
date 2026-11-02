import { createRequire } from 'node:module';

// The only place the server loads SheetJS. Since 0.20 an ES module import gets a build without
// file access or the codepage tables that older .xls files need; the CommonJS build has both.
export default createRequire(import.meta.url)('xlsx');
