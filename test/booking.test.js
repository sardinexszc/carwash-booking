// Run: node test/booking.test.js
const assert = require('assert');
const { digits, slotMinutes, processNewBookings, matchBooking, handleCommand, findNoShows, dueReminders, ownerSummary } = require('../lib/booking');

const row = (n, extra) => ({ row_number: n, Name: 'A' + n, Phone: '0917 123 456' + n, Vehicle: 'Civic', Service: 'Full Detail', Date: '2026-11-02', 'Time slot': '10:00', Notes: '', 'Booking ID': '', Status: '', 'Chat ID': '', Reminded: '', ...extra });

assert.strictEqual(digits('+63 917 123 4567'), digits('0917-123-4567'));

// Two new rows, same slot: first New, second Conflict. Cancelled row doesn't hold the slot.
let out = processNewBookings([
  row(4), row(2, { 'Booking ID': 'CW-0002', Status: 'Cancelled' }), row(3), row(5, { 'Time slot': '13:00' }),
]);
assert.deepStrictEqual(out.map(o => [o.row_number, o.bookingId, o.status]),
  [[3, 'CW-0003', 'New'], [4, 'CW-0004', 'Conflict'], [5, 'CW-0005', 'New']]);
assert.ok(out[1].text.includes('SLOT ALREADY TAKEN'));

// Existing confirmed booking blocks a new one; already-processed rows are skipped.
out = processNewBookings([row(2, { 'Booking ID': 'CW-0002', Status: 'Confirmed' }), row(3)]);
assert.deepStrictEqual(out.map(o => o.status), ['Conflict']);

// Contact matching: own contact, latest non-cancelled row wins.
const rows = [row(2, { Phone: '09171112222', Status: 'New' }), row(3, { Phone: '0917 111 2222', Status: 'Conflict' }), row(4, { Phone: '09171112222', Status: 'Cancelled' })];
const msg = (contact) => ({ chat: { id: 99 }, from: { id: 7 }, contact });
let m = matchBooking(rows, msg({ user_id: 7, phone_number: '+639171112222' }));
assert.strictEqual(m.found, true);
assert.strictEqual(m.row_number, 3);
assert.ok(m.text.includes('already taken'));
assert.strictEqual(matchBooking(rows, msg({ user_id: 8, phone_number: '+639171112222' })).found, false);
assert.strictEqual(matchBooking(rows, msg({ user_id: 7, phone_number: '+639990000000' })).found, false);
assert.strictEqual(matchBooking([row(2, { Phone: '' })], msg({ user_id: 7, phone_number: '' })).found, false);

// Reminders: only tomorrow, active, linked, not yet reminded.
const r = [
  row(2, { Status: 'Confirmed', 'Chat ID': 1 }),
  row(3, { Status: 'New', 'Chat ID': 2, Reminded: 'yes' }),
  row(4, { Status: 'Cancelled', 'Chat ID': 3 }),
  row(5, { Status: 'New', 'Chat ID': '' }),
  row(6, { Status: 'New', 'Chat ID': 4, Date: '2026-11-03' }),
  row(7, { Status: 'New', 'Chat ID': 5, 'Time slot': '8:00' }),
];
assert.deepStrictEqual(dueReminders(r, '2026-11-02').map(x => x.row_number), [2, 7]);

const s = ownerSummary(r, '2026-11-02').text;
assert.ok(s.includes('4 booking(s)'));
assert.ok(s.indexOf('8:00') < s.indexOf('10:00'), 'sorted by slot');
assert.ok(ownerSummary([], '2026-11-02').text.includes('No bookings'));

// Slots compare by time even if Sheets reformats them.
assert.strictEqual(slotMinutes('10:00'), 600);
assert.strictEqual(slotMinutes('10:00:00'), 600);
assert.strictEqual(slotMinutes('1:00 PM'), 780);
assert.strictEqual(slotMinutes('12:00 AM'), 0);
assert.ok(isNaN(slotMinutes('soon')));
assert.deepStrictEqual(processNewBookings([row(2, { 'Booking ID': 'CW-0002', Status: 'New', 'Time slot': '10:00:00' }), row(3)]).map(o => o.status), ['Conflict']);

// No-shows: today, New/Confirmed, slot start + 30 min passed. Arrived is safe.
const today = [
  row(2, { Status: 'Confirmed', 'Time slot': '8:00', 'Chat ID': 11 }),
  row(3, { Status: 'Arrived', 'Time slot': '8:00' }),
  row(4, { Status: 'New', 'Time slot': '10:00' }),
];
assert.deepStrictEqual(findNoShows(today, '2026-11-02', 8 * 60 + 30).map(x => [x.row_number, x.chatId]), [[2, '11']]);
assert.deepStrictEqual(findNoShows(today, '2026-11-02', 8 * 60 + 29), []);
assert.deepStrictEqual(findNoShows(today, '2026-11-03', 23 * 60), []);

// Bot commands. Owner chat 500, customer chat 77; "today" is 2026-11-02 09:00.
const OWNER = 500;
const book = () => [
  row(2, { 'Booking ID': 'CW-0002', Status: 'Confirmed', 'Chat ID': 77, 'Time slot': '10:00' }),
  row(3, { 'Booking ID': 'CW-0003', Status: 'New', 'Chat ID': '', Date: '2026-11-05', 'Time slot': '13:00' }),
];
const say = (chat, text, rows = book()) => handleCommand(rows, { chat: { id: chat }, text }, OWNER, '2026-11-02', 540);

assert.deepStrictEqual(say(12345, '/start'), { askPhone: true });
assert.ok(say(77, '/start').messages[0].text.includes('CW-0002'));

let c = say(77, '/reschedule 2026-11-05 13:00');
assert.strictEqual(c.update, null);
assert.ok(c.messages[0].text.includes('taken'));
assert.ok(say(77, '/reschedule 2026-11-02 8:00').messages[0].text.includes('passed'));
assert.ok(say(77, '/reschedule 2026-02-30 10:00').messages[0].text.includes('Use:'));
assert.ok(say(77, '/reschedule 2026-11-05 9:00').messages[0].text.includes('must be one of'));
c = say(77, '/reschedule 2026-11-05 10:00:00');
assert.deepStrictEqual(c.update, { row_number: 2, Date: '2026-11-05', 'Time slot': '10:00', Status: 'New', Reminded: '' });
assert.deepStrictEqual(c.messages.map(m => m.chatId), [77, OWNER]);
// Moving within the same day to its own current slot is allowed (it doesn't block itself).
assert.ok(say(77, '/reschedule 2026-11-02 10:00').update);

c = say(77, '/cancel');
assert.strictEqual(c.update.Status, 'Cancelled');
const cancelled = book(); cancelled[0].Status = 'Cancelled';
assert.ok(say(77, '/cancel', cancelled).messages[0].text.includes('no active booking'));

assert.ok(say(77, '/slots 2026-11-05').messages[0].text.includes('8:00, 10:00, 15:00'));
assert.ok(say(77, '/slots 2026-11-02').messages[0].text.endsWith('15:00'), 'past 8:00 hidden, 10:00 taken');

// Owner: status changes notify linked customers only; customers can't use owner commands.
c = say(OWNER, '/noshow CW-0002');
assert.strictEqual(c.update.Status, 'No-show');
assert.deepStrictEqual(c.messages.map(m => m.chatId), [OWNER, 77]);
c = say(OWNER, '/confirm 3');
assert.strictEqual(c.update.Status, 'Confirmed');
assert.strictEqual(c.messages.length, 1);
assert.strictEqual(say(OWNER, '/arrived CW-0002').messages.length, 1);
assert.ok(say(OWNER, '/confirm CW-0999').messages[0].text.includes('not found'));
assert.ok(say(OWNER, '/today@MyBot').messages[0].text.includes('CW-0002'));
c = say(OWNER, '/move CW-0003 2026-11-06 8:00');
assert.strictEqual(c.update.Date, '2026-11-06');
assert.strictEqual(say(77, '/confirm CW-0002').update, null);
// No-show customer can rebook.
const missed = book(); missed[0].Status = 'No-show';
assert.ok(say(77, '/reschedule 2026-11-04 10:00', missed).update);

console.log('all tests passed');
