/**
 * Fixture that fails the way a broken CLI invocation does:
 * a message on stderr and a non-zero exit code.
 */
'use strict';

const fs = require('node:fs');

fs.writeSync(2, 'fixture failure: cannot reach the model provider\n');
process.exitCode = 3;
