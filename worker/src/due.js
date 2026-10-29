// Pure helpers for the reminder schedule (kept separate so they can be tested without Cloudflare).
export function localParts(ms, tz){
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', weekday:'short' });
  const o = {}; f.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  const hour = Number(o.hour) % 24;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: hour * 60 + Number(o.minute), weekday: o.weekday };
}
const toMin = (hhmm, dflt) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : dflt; };

// Which reminders are due for these prefs right now? The cron runs every 15 minutes, so a reminder is due
// when the local time is within 15 minutes after its target.
export function dueReminders(prefs, nowMs, windowMin = 15){
  const tz = prefs.tz || 'America/Detroit';
  const lp = localParts(nowMs, tz); const out = [];
  const inWindow = (target) => lp.minutes >= target && lp.minutes < target + windowMin;
  if (prefs.morning && inWindow(toMin(prefs.morningTime, 6 * 60 + 30)))
    out.push({ key: 'm:' + lp.date, title: 'Readiness check', body: 'Ten seconds: sleep, energy, back and hips. It sets today\'s plan.', tag: 'morning' });
  if (prefs.weekly && lp.weekday === 'Sun' && inWindow(toMin(prefs.weeklyTime, 19 * 60)))
    out.push({ key: 'w:' + lp.date, title: 'Weekly review', body: 'See what you lifted this week and whether a deload makes sense.', tag: 'weekly' });
  return out;
}
