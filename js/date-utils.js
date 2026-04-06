/* date-utils.js — arXiv date helpers (global scope, no module system) */

/**
 * Most recent weekday on which arXiv listings are available.
 * arXiv publishes new listings during the day, so today is included
 * as long as it is a weekday.
 */
function latestArxivDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/** Step back one arXiv publishing day (skip weekends). */
function previousArxivDay(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/**
 * Step forward one arXiv publishing day (skip weekends).
 * Returns the same date if already at the latest available day.
 */
function nextArxivDay(date) {
  const latest = latestArxivDay();
  if (isoDate(date) >= isoDate(latest)) return new Date(date);
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d > latest ? latest : d;
}

/** "Monday, March 24, 2026" */
function formatDisplayDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/** "Mon, Mar 24" — compact form for nav bar */
function formatShortDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/** "YYYY-MM-DD" */
function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "YYYYMMDD" for arXiv lastUpdatedDate queries */
function formatQueryDate(date) {
  return isoDate(date).replace(/-/g, '');
}

/** Parse "YYYY-MM-DD" back to a Date (local time) */
function dateFromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Build the calendar grid for a given year/month.
 * Returns an array of cell objects:
 *   { empty, day, date, isWeekend, isToday, isFuture, isAvailable }
 */
function buildCalendarDays(year, month) {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const latest = latestArxivDay();

  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const cells = [];

  // Leading empty cells so the grid starts on the right weekday
  for (let i = 0; i < firstDay.getDay(); i++) {
    cells.push({ empty: true });
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const date = new Date(year, month, d);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const isToday   = date.getTime() === todayMidnight.getTime();
    const isFuture  = date > todayMidnight;
    cells.push({
      empty: false,
      day: d,
      date,
      isWeekend,
      isToday,
      isFuture,
      isAvailable: !isWeekend && date <= latest,
    });
  }

  return cells;
}
