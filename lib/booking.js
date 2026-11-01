// Booking logic shared by the n8n Code nodes. build.js inlines everything above the
// "--- exports ---" marker into the workflows; test/booking.test.js tests it.
// Rows are Google Sheets rows as n8n reads them: column headers as keys, plus row_number.

const SLOTS = ['8:00', '10:00', '13:00', '15:00']; // must match the form's Time slot dropdown
const NO_SHOW_GRACE_MIN = 30;
const HOLDS = ['New', 'Confirmed', 'Arrived']; // statuses that occupy a slot
const ACTIVE = ['New', 'Confirmed']; // statuses that get reminders / can become No-show
const CHANGEABLE = ['New', 'Confirmed', 'Conflict', 'No-show']; // customer may reschedule or cancel

// Last 10 digits, so "0917 123 4567" and "+63 917 123 4567" match.
function digits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// "10:00", "10:00:00" or "10:00 AM" -> minutes since midnight. Sheets may reformat the
// slot text, so slots are always compared by minutes. NaN if unreadable.
function slotMinutes(slot) {
  const m = String(slot || '').trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])?\.?m?\.?$/i);
  if (!m) return NaN;
  let h = +m[1] % (m[3] ? 12 : 24);
  if (m[3] && /p/i.test(m[3])) h += 12;
  return h * 60 + (+m[2] || 0);
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function freeSlots(rows, date, except) {
  return SLOTS.filter(s => !rows.some(r => r !== except && r['Date'] === date
    && HOLDS.includes(r['Status']) && slotMinutes(r['Time slot']) === slotMinutes(s)));
}

function findById(rows, id) {
  const n = parseInt(String(id || '').replace(/\D/g, ''), 10);
  return rows.find(r => r['Booking ID'] && parseInt(String(r['Booking ID']).replace(/\D/g, ''), 10) === n);
}

function summary(r) {
  return [
    `Booking ${r['Booking ID']} (${r['Status']})`,
    `Name: ${r['Name']}`,
    `Phone: ${r['Phone']}`,
    `Vehicle: ${r['Vehicle']}`,
    `Service: ${r['Service']}`,
    `When: ${r['Date']} ${r['Time slot']}`,
    r['Notes'] ? `Notes: ${r['Notes']}` : '',
  ].filter(Boolean).join('\n');
}

const CUSTOMER_HELP = 'Commands:\n/mybooking - show your booking\n/slots YYYY-MM-DD - free times on a day\n/reschedule YYYY-MM-DD HH:MM - move your booking\n/cancel - cancel your booking';
const OWNER_HELP = 'Owner commands (ID like CW-0003 or 3):\n/today - today\'s bookings\n/confirm ID\n/arrived ID\n/done ID\n/noshow ID\n/cancel ID\n/move ID YYYY-MM-DD HH:MM\n/slots YYYY-MM-DD';
const NO_SHOW_TEXT = (r) => `We missed you for booking ${r['Booking ID']} (${r['Date']} ${r['Time slot']}).\nTo book a new time, send /slots YYYY-MM-DD then /reschedule YYYY-MM-DD HH:MM.`;

// Workflow 1: give every row without a Booking ID an ID and a status.
// Earlier rows win a slot; Cancelled, Conflict, No-show rows don't hold one.
function processNewBookings(rows) {
  const sorted = [...rows].sort((a, b) => a.row_number - b.row_number);
  const out = [];
  for (const row of sorted) {
    if (row['Booking ID']) continue;
    const clash = sorted.some(o => o !== row && o['Booking ID']
      && HOLDS.includes(o['Status'])
      && o['Date'] === row['Date'] && slotMinutes(o['Time slot']) === slotMinutes(row['Time slot']));
    row['Booking ID'] = 'CW-' + String(row.row_number).padStart(4, '0');
    row['Status'] = clash ? 'Conflict' : 'New';
    const head = clash ? '⚠️ SLOT ALREADY TAKEN - contact customer to rebook\n' : '🚗 New booking\n';
    const hint = clash ? `\n\n/move ${row['Booking ID']} YYYY-MM-DD HH:MM` : `\n\n/confirm ${row['Booking ID']}`;
    out.push({ row_number: row.row_number, bookingId: row['Booking ID'], status: row['Status'], text: head + summary(row) + hint });
  }
  return out;
}

// Workflow 2: customer shared their contact with the bot; find their latest booking.
function matchBooking(rows, message) {
  const chatId = message.chat.id;
  const contact = message.contact;
  // A user can also send someone else's contact card; only accept their own number.
  if (!contact || contact.user_id !== message.from.id) {
    return { found: false, chatId, text: 'Please tap the "Share my phone" button to send your own number.' };
  }
  const phone = digits(contact.phone_number);
  const row = phone.length >= 7
    ? rows.filter(r => digits(r['Phone']) === phone && r['Status'] !== 'Cancelled').pop()
    : undefined;
  if (!row) {
    return { found: false, chatId, text: 'No booking found for this number. Please book using our form first, then come back here.' };
  }
  const note = row['Status'] === 'Conflict'
    ? '\n\nSorry, this time slot is already taken. Send /slots YYYY-MM-DD to see free times, then /reschedule.'
    : '\n\nYou will get a reminder here the day before.';
  return { found: true, chatId, row_number: row.row_number, text: '✅ Booking linked!\n\n' + summary(row) + note + '\n\n' + CUSTOMER_HELP };
}

// Shared by owner /move and customer /reschedule. Returns { error } or { update, from, to }.
function reschedule(rows, row, date, slot, today, nowMin) {
  if (!validDate(date)) return { error: 'Use: YYYY-MM-DD HH:MM, e.g. /reschedule 2026-11-05 10:00' };
  const label = SLOTS.find(s => slotMinutes(s) === slotMinutes(slot));
  if (!label) return { error: `Time must be one of: ${SLOTS.join(', ')}` };
  if (date < today || (date === today && slotMinutes(label) <= nowMin)) return { error: 'That time has already passed.' };
  const free = freeSlots(rows, date, row);
  if (!free.includes(label)) return { error: `${date} ${label} is taken. Free that day: ${free.join(', ') || 'none'}` };
  return {
    update: rowUpdate(row, { Date: date, 'Time slot': label, Status: 'New', Reminded: '' }),
    from: `${row['Date']} ${row['Time slot']}`,
    to: `${date} ${label}`,
  };
}

// The bot workflow writes these 5 columns back for the changed row.
function rowUpdate(row, changes) {
  return { row_number: row.row_number, Date: row['Date'], 'Time slot': row['Time slot'], Status: row['Status'], Reminded: row['Reminded'] || '', ...changes };
}

// Workflow 2: any non-contact message. owner = OWNER_CHAT_ID, today = "YYYY-MM-DD",
// nowMin = minutes since midnight. Returns { askPhone } or { update|null, messages: [{chatId, text}] }.
function handleCommand(rows, message, owner, today, nowMin) {
  const chatId = message.chat.id;
  const [first = '', ...args] = String(message.text || '').trim().split(/\s+/);
  const cmd = first.toLowerCase().replace(/@.*/, ''); // "/today@MyBot" in groups
  const reply = (text) => ({ update: null, messages: [{ chatId, text }] });

  if (cmd === '/slots') {
    if (!validDate(args[0])) return reply('Use: /slots YYYY-MM-DD');
    const free = freeSlots(rows, args[0]).filter(s => args[0] > today || (args[0] === today && slotMinutes(s) > nowMin));
    return reply(`Free times on ${args[0]}: ${free.join(', ') || 'none'}`);
  }

  if (String(chatId) === String(owner)) {
    if (cmd === '/today') return reply(ownerSummary(rows, today, 'Today').text);
    const statuses = { '/confirm': 'Confirmed', '/arrived': 'Arrived', '/done': 'Done', '/noshow': 'No-show', '/cancel': 'Cancelled' };
    if (!statuses[cmd] && cmd !== '/move') return reply(OWNER_HELP);
    const row = findById(rows, args[0]);
    if (!row) return reply(`Booking ${args[0] || '(missing ID)'} not found.`);
    const customer = row['Chat ID'];
    if (cmd === '/move') {
      const r = reschedule(rows, row, args[1], args[2], today, nowMin);
      if (r.error) return reply(r.error);
      const messages = [{ chatId, text: `${row['Booking ID']} moved: ${r.from} -> ${r.to}` }];
      if (customer) messages.push({ chatId: customer, text: `Your booking ${row['Booking ID']} was moved to ${r.to}.` });
      return { update: r.update, messages };
    }
    const status = statuses[cmd];
    const messages = [{ chatId, text: `${row['Booking ID']} (${row['Name']}) -> ${status}` }];
    const notice = {
      Confirmed: `✅ Your booking ${row['Booking ID']} on ${row['Date']} ${row['Time slot']} is confirmed.`,
      Cancelled: `Your booking ${row['Booking ID']} on ${row['Date']} ${row['Time slot']} was cancelled.`,
      'No-show': NO_SHOW_TEXT(row),
      Done: 'Thanks for visiting! See you next time. 🚗✨',
    }[status];
    if (customer && notice) messages.push({ chatId: customer, text: notice });
    return { update: rowUpdate(row, { Status: status }), messages };
  }

  const mine = rows.filter(r => r['Chat ID'] && String(r['Chat ID']) === String(chatId));
  if (!mine.length) return { askPhone: true };
  const row = mine.filter(r => CHANGEABLE.includes(r['Status'])).pop();
  if (!row) return reply('You have no active booking. Please book again using our form.');

  if (cmd === '/cancel') {
    return {
      update: rowUpdate(row, { Status: 'Cancelled' }),
      messages: [
        { chatId, text: `Your booking ${row['Booking ID']} is cancelled.` },
        { chatId: owner, text: `❌ Customer cancelled ${row['Booking ID']} (${row['Name']}, ${row['Date']} ${row['Time slot']})` },
      ],
    };
  }
  if (cmd === '/reschedule') {
    const r = reschedule(rows, row, args[0], args[1], today, nowMin);
    if (r.error) return reply(r.error);
    return {
      update: r.update,
      messages: [
        { chatId, text: `✅ Booking ${row['Booking ID']} moved to ${r.to}. We will confirm shortly.` },
        { chatId: owner, text: `🔁 Customer rescheduled ${row['Booking ID']} (${row['Name']}): ${r.from} -> ${r.to}\n\n/confirm ${row['Booking ID']}` },
      ],
    };
  }
  return reply(summary(row) + '\n\n' + CUSTOMER_HELP);
}

// Workflow 4: bookings still New/Confirmed (not Arrived) past slot start + grace time.
function findNoShows(rows, today, nowMin) {
  return rows
    .filter(r => r['Date'] === today && ACTIVE.includes(r['Status']) && slotMinutes(r['Time slot']) + NO_SHOW_GRACE_MIN <= nowMin)
    .map(r => ({
      row_number: r.row_number,
      chatId: String(r['Chat ID'] || ''),
      customerText: NO_SHOW_TEXT(r),
      ownerText: `🚫 No-show: ${r['Booking ID']} ${r['Name']} ${r['Phone']} (${r['Time slot']}). Marked No-show.\nIf they came, send /arrived ${r['Booking ID']}`,
    }));
}

// Workflow 3: customers to remind about tomorrow (tomorrow is "YYYY-MM-DD").
function dueReminders(rows, tomorrow) {
  return rows
    .filter(r => r['Date'] === tomorrow && ACTIVE.includes(r['Status']) && r['Chat ID'] && !r['Reminded'])
    .map(r => ({
      row_number: r.row_number,
      chatId: r['Chat ID'],
      text: `⏰ Reminder: your ${r['Service']} is tomorrow (${r['Date']}) at ${r['Time slot']}.\nBooking ${r['Booking ID']} - ${r['Vehicle']}.\nNeed to change? /reschedule YYYY-MM-DD HH:MM or /cancel`,
    }));
}

// Workflow 3 and owner /today: the day's schedule.
function ownerSummary(rows, date, label = 'Tomorrow') {
  const list = rows
    .filter(r => r['Date'] === date && HOLDS.includes(r['Status']))
    .sort((a, b) => slotMinutes(a['Time slot']) - slotMinutes(b['Time slot']));
  if (!list.length) return { text: `📅 No bookings for ${label.toLowerCase()} (${date}).` };
  const lines = list.map(r => `${r['Time slot']} - ${r['Booking ID']} ${r['Service']} - ${r['Name']} (${r['Vehicle']}) ${r['Phone']} [${r['Status']}]`);
  return { text: `📅 ${label} (${date}) - ${list.length} booking(s):\n` + lines.join('\n') };
}

// --- exports ---
module.exports = { digits, slotMinutes, processNewBookings, matchBooking, handleCommand, findNoShows, dueReminders, ownerSummary };
