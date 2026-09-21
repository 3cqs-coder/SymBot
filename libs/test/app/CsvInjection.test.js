'use strict';

// Pins the CSV formula-injection mitigation in TransactionExport.csvField (used by BOTH the tax
// TransactionExport and the deal-summary DealCsv via rowsToCsv). A cell that begins with = + - @ (or a
// leading tab / carriage return) is executed as a formula by Excel / Google Sheets when the file is
// opened, so a free-text journal note or a crafted pair symbol could run =HYPERLINK(...) etc. The fix
// prefixes such a cell with a single quote so it is treated as literal text — but ONLY when the value is
// not a plain number, so legitimate negative amounts (e.g. -30.50) stay numeric for tax/spreadsheet tools.
//
// csvField is internal; it is exercised through the exported rowsToCsv.

const assert = require('assert');
const TransactionExport = require('../../app/TransactionExport.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// One row, two columns; parse the single data line back into its quoted fields.
function fieldsFor(value) {
	const csv = TransactionExport.rowsToCsv([{ a: value, b: 'x' }], { headers: ['a', 'b'] });
	const dataLine = csv.split('\r\n')[1];   // [0] = header row, [1] = our row
	return dataLine;
}

// ── Formula-triggering cells are neutralized with a leading single quote ──────
const dangerous = [
	'=HYPERLINK("http://evil/",A1)',
	'=1+1',
	'+1+2',
	'-2+3',                       // starts with '-' but is NOT a plain number → must be neutralized
	'@SUM(A1:A9)',
	'\t=cmd',                    // leading tab then a formula
	'\r=cmd'                     // leading CR then a formula
];

for (const v of dangerous) {
	const line = fieldsFor(v);
	// The field is quoted; a neutralized cell begins with "' (quote then the injected single-quote).
	ok(line.indexOf('"\'') === 0, 'formula cell neutralized with a leading quote: ' + JSON.stringify(v) + ' -> ' + line);
}

// ── Legitimate numbers are NOT altered (tax tools must still parse them) ──────
const numbers = ['-30.50', '-0.02', '30.50', '0', '+1', '1.23', '.5', '-.5'];

for (const n of numbers) {
	const line = fieldsFor(n);
	ok(line === '"' + n + '","x"', 'plain number left intact: ' + JSON.stringify(n) + ' -> ' + line);
}

// ── Ordinary text is unchanged; embedded quotes are still doubled ────────────
ok(fieldsFor('BTC/USDT') === '"BTC/USDT","x"', 'ordinary text unchanged');
ok(fieldsFor('he said "hi"') === '"he said ""hi""","x"', 'embedded quotes still doubled');
ok(fieldsFor('') === '"","x"', 'empty field stays empty');
ok(fieldsFor(null) === '"","x"', 'null field stays empty');

// A dangerous value that also contains a quote is both neutralized AND quote-doubled.
ok(fieldsFor('=A1&"x"') === '"\'=A1&""x""","x"', 'neutralized and quote-doubled together');

console.log('CsvInjection.test.js: ' + passed + ' assertions passed');
