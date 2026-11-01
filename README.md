# Carwash Booking (Google Forms + Sheets + n8n + Telegram)

```
Customer fills Google Form -> Response sheet -> n8n #1 (every minute): assign ID, check slot -> Telegram alert to owner
Customer opens bot, shares phone -> n8n #2: link chat to booking; handles all bot commands
Every day 18:00 -> n8n #3: reminder to tomorrow's customers + tomorrow's list to owner
Every 15 min -> n8n #4: mark No-show 30 min after slot start if not Arrived; tell owner + customer
```

No AI or local LLM (Ollama etc.) needed: all logic is fixed rules.

## Install (Windows 10/11)

Do steps 1-3 first, then run the installer.

### 1. Google Form

Create a form with these 7 questions, in this order. Titles must match exactly: they become sheet column headers. Extra questions may go after Notes; the automation ignores them.

| Question | Type | Notes |
|---|---|---|
| Name | Short answer | required |
| Phone | Short answer | required; the number linked to the customer's Telegram (matched on last 10 digits) |
| Vehicle | Short answer | "Make / model / plate" |
| Service | Dropdown | Basic Wash, Interior, Full Detail, Ceramic |
| Date | Date | required; "Include year" on, "Include time" off |
| Time slot | Dropdown | 8:00, 10:00, 13:00, 15:00 (24h, one car per slot) |
| Notes | Paragraph | optional |

Settings > Presentation > Confirmation message:

> Thanks! To get your confirmation and reminder on Telegram, open t.me/YOUR_BOT_USERNAME and press Start.

Responses > Link to Sheets > create new spreadsheet.

### 2. Google Sheet

In the response tab (default `Form Responses 1`):

1. Add 4 headers right of `Notes`: `Booking ID`, `Status`, `Chat ID`, `Reminded`.
2. Select column `Date` > Format > Number > Custom date and time > `yyyy-mm-dd`.
3. Optional: Data validation on `Status`: `New, Conflict, Confirmed, Arrived, Done, No-show, Cancelled`.

### 3. Accounts (one time)

- **Telegram bot**: message @BotFather > `/newbot` > copy the token. Get your chat ID from @userinfobot. For a staff group: add the bot to the group, use the group ID (starts with `-`).
- **Google service account** (lets n8n edit the sheet, no login pop-ups):
  1. console.cloud.google.com > create a project.
  2. APIs & Services > Library > enable **Google Sheets API** and **Google Drive API**.
  3. IAM & Admin > Service Accounts > Create > no roles needed > Done.
  4. Open it > Keys > Add key > JSON. A `.json` file downloads. Keep it private.

### 4. Run the installer

Double-click `install.cmd`. It:

1. Installs Node.js, n8n and cloudflared (via winget / npm) if missing.
2. Asks for the sheet URL, tab name, your chat ID, timezone, bot token, and the service account `.json` path.
3. Saves the bot token and Google key into n8n's encrypted credential store.
4. Imports and activates the 4 workflows, already connected to your sheet and bot.
5. Creates a **Carwash Booking** desktop shortcut.

Then:

1. Share the Google Sheet with the service account email (the installer prints it) as **Editor**.
2. Double-click **Carwash Booking**. Keep the window open while the shop is open. It starts a free Cloudflare tunnel (Telegram needs a public HTTPS address) and n8n.
3. First time only: n8n opens in the browser. Create your n8n login.
4. If the installer said so: open each "Carwash" workflow and switch it to Active/Published.

Run `install.cmd` again any time to change settings (Enter keeps the current value). Close the Carwash Booking window first.

## Daily use

### Statuses

| Status | Set by | Meaning |
|---|---|---|
| New | n8n | booked or rescheduled, waiting for you to confirm |
| Conflict | n8n | slot already taken; rebook with `/move` |
| Confirmed | you | customer gets a confirmation message |
| Arrived | you | car is here; stops the no-show check |
| Done | you | customer gets a thank-you |
| No-show | n8n or you | 30 min after slot start and not Arrived; customer is invited to reschedule |
| Cancelled | you or customer | frees the slot |

You can edit the sheet directly too. Messages are only sent for changes made through the bot.

### Owner commands (from the owner chat / staff group)

```
/today                          today's bookings
/confirm CW-0003                (or just /confirm 3)
/arrived CW-0003                mark the car as arrived - do this or it becomes No-show
/done CW-0003
/noshow CW-0003
/cancel CW-0003
/move CW-0003 2026-11-05 10:00  reschedule; customer is told
/slots 2026-11-05               free times that day
```

### Customer commands

```
/mybooking
/slots 2026-11-05
/reschedule 2026-11-05 10:00    goes back to New; you get a /confirm prompt
/cancel
```

Customers can reschedule or cancel bookings that are New, Confirmed, Conflict or No-show. A reschedule to a taken or past slot is refused with the free times.

## Test

1. Submit the form twice with the same date + slot. Within ~1 minute: two owner alerts, the second "SLOT ALREADY TAKEN"; sheet shows `CW-0002 New`, `CW-0003 Conflict`.
2. Open the bot > Start > tap "Share my phone" (the form's number). You get the booking; `Chat ID` fills in.
3. Send `/reschedule <tomorrow> 15:00`. Sheet row changes, owner gets a notice.
4. In n8n open workflow 3 > Execute workflow. Reminder arrives, `Reminded` = yes. Run again: no second reminder.
5. Book a slot for today that started 30+ min ago, wait up to 15 min: status becomes No-show, both get messages.

## Settings in code

`lib/booking.js` top: time slots, no-show grace minutes. After editing: `node build.js`, then run `install.cmd` again.

## Files

- `install.cmd`, `installer/` - installer and the start script it puts in `%LOCALAPPDATA%\CarwashBooking`.
- `workflows/*.json` - the 4 n8n workflows (generated; placeholders filled in by the installer).
- `lib/booking.js` - all booking logic. `build.js` inlines it into the workflows.
- `test/booking.test.js` - `node test/booking.test.js`.

## Limits

- PC must be on with the Carwash Booking window open. For 24/7, run n8n on a cheap VPS instead.
- The free tunnel gets a new URL each start; n8n re-registers the Telegram webhook on startup.
- One car per slot. No closed-days or opening-hours check on reschedule.
- Google Forms can't block a taken slot; the customer sees "slot taken" in Telegram and reschedules.
- Customers who never open the bot get no messages. Call/text them from the Phone column.
- Phones match on the last 10 digits.
