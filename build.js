// Generates workflows/*.json with lib/booking.js inlined into the Code nodes.
// Run: node build.js   (only needed after editing lib/booking.js or this file)
const fs = require('fs');
const path = require('path');

const lib = fs.readFileSync(path.join(__dirname, 'lib/booking.js'), 'utf8').split('// --- exports ---')[0];
const OWNER = 'OWNER_CHAT_ID';
const SHEET_ID = 'SHEET_ID';
const TAB = 'Form Responses 1';

const doc = { __rl: true, value: SHEET_ID, mode: 'id' };
const tab = { __rl: true, value: TAB, mode: 'name' };
const noAttribution = { appendAttribution: false };

// The installer imports credentials with these IDs, so nodes come pre-connected.
const GOOGLE = { googleApi: { id: 'carwashGoogle001', name: 'Carwash Google Service Account' } };
const TELEGRAM = { telegramApi: { id: 'carwashTelegram1', name: 'Carwash Telegram Bot' } };

let x = 0;
function node(name, type, typeVersion, parameters, extra = {}) {
  const n = { id: `${name.replace(/\W/g, '-').toLowerCase()}`, name, type, typeVersion, position: [(x += 220), 300], parameters, ...extra };
  if (type === 'n8n-nodes-base.googleSheets') { n.parameters = { authentication: 'serviceAccount', ...parameters }; n.credentials = GOOGLE; }
  if (type.startsWith('n8n-nodes-base.telegram')) n.credentials = TELEGRAM;
  return n;
}

const readRows = (name, extra) => node(name, 'n8n-nodes-base.googleSheets', 4.5,
  { operation: 'read', documentId: doc, sheetName: tab, options: {} }, extra);

const col = (id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true });
const updateRow = (name, values) => node(name, 'n8n-nodes-base.googleSheets', 4.5, {
  operation: 'update', documentId: doc, sheetName: tab,
  columns: { mappingMode: 'defineBelow', value: values, matchingColumns: ['row_number'], schema: Object.keys(values).map(col) },
  options: {},
});

const code = (name, snippet) => node(name, 'n8n-nodes-base.code', 2, { jsCode: lib + '\n// --- node ---\n' + snippet });

const telegram = (name, chatId, text, more = {}) => node(name, 'n8n-nodes-base.telegram', 1.2,
  { chatId, text, ...more, additionalFields: noAttribution });

const ifNode = (name, leftValue, operator) => node(name, 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ id: 'c1', leftValue, rightValue: '', operator }],
    combinator: 'and',
  },
  options: {},
});

// links: [from, to] or [from, to, outputIndex]
// Fixed workflow IDs: re-running the installer updates workflows instead of duplicating them.
function workflow(id, name, nodes, links) {
  const connections = {};
  for (const [from, to, out = 0] of links) {
    const main = (connections[from] ??= { main: [] }).main;
    while (main.length <= out) main.push([]);
    main[out].push({ node: to, type: 'main', index: 0 });
  }
  x = 0;
  return { id, name, nodes, connections, settings: { executionOrder: 'v1' }, active: false };
}

// Polls with a schedule instead of the Sheets Trigger: the trigger doesn't take a service
// account, and rows without a Booking ID are exactly the new ones anyway.
const wf1 = workflow('carwashIntake001', 'Carwash 1 - Booking intake', [
  node('Every minute', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } }),
  readRows('Read all bookings'),
  code('Assign ID and check slot', 'return processNewBookings($input.all().map(i => i.json)).map(json => ({ json }));'),
  updateRow('Write ID and status', {
    row_number: '={{ $json.row_number }}', 'Booking ID': '={{ $json.bookingId }}', Status: '={{ $json.status }}',
  }),
  telegram('Alert owner', OWNER, "={{ $('Assign ID and check slot').item.json.text }}"),
], [
  ['Every minute', 'Read all bookings'],
  ['Read all bookings', 'Assign ID and check slot'],
  ['Assign ID and check slot', 'Write ID and status'],
  ['Write ID and status', 'Alert owner'],
]);

const now = "$now.toISODate(), $now.hour * 60 + $now.minute";

// Telegram allows one webhook per bot, so every bot message goes through this workflow.
const wf2 = workflow('carwashTgBot0001', 'Carwash 2 - Telegram bot', [
  node('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.1, { updates: ['message'], additionalFields: {} }),
  ifNode('Shared contact?', '={{ $json.message.contact }}', { type: 'object', operation: 'exists', singleValue: true }),
  readRows('Read bookings for command'),
  code('Handle command', `const r = handleCommand($input.all().map(i => i.json), $('Telegram Trigger').first().json.message, '${OWNER}', ${now});
return [{ json: { askPhone: !!r.askPhone, hasUpdate: !!r.update, update: r.update || {}, messages: r.messages || [] } }];`),
  ifNode('Not linked yet?', '={{ $json.askPhone }}', { type: 'boolean', operation: 'true', singleValue: true }),
  ifNode('Changes sheet?', '={{ $json.hasUpdate }}', { type: 'boolean', operation: 'true', singleValue: true }),
  node('Apply change', 'n8n-nodes-base.googleSheets', 4.5, {
    operation: 'update', documentId: doc, sheetName: tab,
    columns: {
      mappingMode: 'defineBelow',
      value: Object.fromEntries(['row_number', 'Date', 'Time slot', 'Status', 'Reminded'].map(k => [k, `={{ $json.update['${k}'] }}`])),
      matchingColumns: ['row_number'],
      schema: ['row_number', 'Date', 'Time slot', 'Status', 'Reminded'].map(col),
    },
    // RAW keeps "2026-11-05" and "10:00" as typed instead of Sheets converting them.
    options: { cellFormat: 'RAW' },
  }),
  code('Split messages', "return $('Handle command').first().json.messages.map(json => ({ json }));"),
  telegram('Send messages', '={{ $json.chatId }}', '={{ $json.text }}'),
  telegram('Ask for phone', "={{ $('Telegram Trigger').first().json.message.chat.id }}",
    'Hi! Tap the button below to share your phone number so we can link your carwash booking.', {
      replyMarkup: 'replyKeyboard',
      replyKeyboard: { rows: [{ row: { buttons: [{ text: '📱 Share my phone', additionalFields: { request_contact: true } }] } }] },
      replyKeyboardOptions: { one_time_keyboard: true, resize_keyboard: true },
    }),
  readRows('Read all bookings'),
  code('Match booking', "return [{ json: matchBooking($input.all().map(i => i.json), $('Telegram Trigger').first().json.message) }];"),
  ifNode('Found?', '={{ $json.found }}', { type: 'boolean', operation: 'true', singleValue: true }),
  updateRow('Save Chat ID', { row_number: '={{ $json.row_number }}', 'Chat ID': '={{ $json.chatId }}' }),
  telegram('Reply to customer', "={{ $('Match booking').item.json.chatId }}", "={{ $('Match booking').item.json.text }}", {
    replyMarkup: 'replyKeyboardRemove', replyKeyboardRemove: { remove_keyboard: true },
  }),
], [
  ['Telegram Trigger', 'Shared contact?'],
  ['Shared contact?', 'Read all bookings', 0],
  ['Shared contact?', 'Read bookings for command', 1],
  ['Read bookings for command', 'Handle command'],
  ['Handle command', 'Not linked yet?'],
  ['Not linked yet?', 'Ask for phone', 0],
  ['Not linked yet?', 'Changes sheet?', 1],
  ['Changes sheet?', 'Apply change', 0],
  ['Changes sheet?', 'Split messages', 1],
  ['Apply change', 'Split messages'],
  ['Split messages', 'Send messages'],
  ['Read all bookings', 'Match booking'],
  ['Match booking', 'Found?'],
  ['Found?', 'Save Chat ID', 0],
  ['Found?', 'Reply to customer', 1],
  ['Save Chat ID', 'Reply to customer'],
]);

const wf3 = workflow('carwashRemind001', 'Carwash 3 - Day-before reminder', [
  node('Every day 18:00', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ triggerAtHour: 18 }] } }),
  readRows('Read all bookings'),
  code('Due reminders', "return dueReminders($input.all().map(i => i.json), $now.plus({ days: 1 }).toISODate()).map(json => ({ json }));"),
  telegram('Remind customer', '={{ $json.chatId }}', '={{ $json.text }}'),
  // After sending, so a failed send is retried next run instead of marked done.
  updateRow('Mark reminded', { row_number: "={{ $('Due reminders').item.json.row_number }}", Reminded: 'yes' }),
  code('Owner summary', "return [{ json: ownerSummary($input.all().map(i => i.json), $now.plus({ days: 1 }).toISODate()) }];"),
  telegram("Send owner tomorrow's list", OWNER, '={{ $json.text }}'),
], [
  ['Every day 18:00', 'Read all bookings'],
  ['Read all bookings', 'Due reminders'],
  ['Read all bookings', 'Owner summary'],
  ['Due reminders', 'Remind customer'],
  ['Remind customer', 'Mark reminded'],
  ['Owner summary', "Send owner tomorrow's list"],
]);

const wf4 = workflow('carwashNoShow001', 'Carwash 4 - No-show check', [
  node('Every 15 minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
  readRows('Read all bookings'),
  code('Find no-shows', `return findNoShows($input.all().map(i => i.json), ${now}).map(json => ({ json }));`),
  updateRow('Mark no-show', { row_number: '={{ $json.row_number }}', Status: 'No-show' }),
  telegram('Alert owner', OWNER, "={{ $('Find no-shows').item.json.ownerText }}"),
  ifNode('Customer linked?', "={{ $('Find no-shows').item.json.chatId }}", { type: 'string', operation: 'notEmpty', singleValue: true }),
  telegram('Message customer', "={{ $('Find no-shows').item.json.chatId }}", "={{ $('Find no-shows').item.json.customerText }}"),
], [
  ['Every 15 minutes', 'Read all bookings'],
  ['Read all bookings', 'Find no-shows'],
  ['Find no-shows', 'Mark no-show'],
  ['Mark no-show', 'Alert owner'],
  ['Mark no-show', 'Customer linked?'],
  ['Customer linked?', 'Message customer', 0],
]);

fs.mkdirSync(path.join(__dirname, 'workflows'), { recursive: true });
for (const [file, wf] of [['1-booking-intake', wf1], ['2-telegram-bot', wf2], ['3-daily-reminder', wf3], ['4-no-show-check', wf4]]) {
  fs.writeFileSync(path.join(__dirname, 'workflows', file + '.json'), JSON.stringify(wf, null, 2));
}
console.log('wrote workflows/*.json');
