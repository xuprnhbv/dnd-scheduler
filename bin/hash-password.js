#!/usr/bin/env node
'use strict';

const bcrypt = require('bcrypt');

async function main() {
  const pw = process.argv[2];
  if (!pw) {
    process.stderr.write('Usage: node bin/hash-password.js <password>\n');
    process.exit(2);
  }
  const hash = await bcrypt.hash(pw, 12);
  process.stdout.write(`${hash}\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
