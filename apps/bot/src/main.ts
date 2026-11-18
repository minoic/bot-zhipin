import { runDemo } from './demo.js';
import { runOnline } from './online.js';
export { runDemo } from './demo.js';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'demo') {
  const text = args.join(' ') || 'navigate to 4 1 0';
  const numbers = text.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const target = { x: numbers[0] ?? 4, y: numbers[1] ?? 1, z: numbers[2] ?? 0 };
  await runDemo(text, target);
} else if (mode === 'online') await runOnline();
else {
  process.stderr.write('Usage: bot demo [goal with x y z] | bot online\n');
  process.exitCode = 2;
}
