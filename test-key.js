const readline = require('readline');
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
  console.log('keypress:', {str, key});
  if (key.ctrl && key.name === 'c') process.exit();
  if (str === '\t') { console.log('tab char matched'); process.exit(); }
  if (key.name === 'tab') { console.log('tab name matched'); process.exit(); }
});
