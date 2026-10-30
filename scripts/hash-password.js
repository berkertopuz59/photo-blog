import { createInterface } from 'node:readline';
import { hashPassword } from '../lib/auth.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Read without echo
const stdin = process.stdin;
stdin.setRawMode && stdin.setRawMode(false);

let password = '';
process.stdin.setEncoding('utf8');

const onData = (chunk) => {
  for (const ch of chunk) {
    if (ch === '\n' || ch === '\r') {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.close();
      if (password.length === 0) {
        process.stderr.write('Empty password.\n');
        process.exit(1);
      }
      const hash = hashPassword(password);
      process.stdout.write(hash + '\n');
      return;
    } else if (ch === '\u007F' || ch === '\b') {
      password = password.slice(0, -1);
    } else {
      password += ch;
    }
  }
};

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdout.write('Password: ');
}

process.stdin.on('data', onData);

rl.on('close', () => {});

