import { isDate } from '../forms/contracts.js';
export type BusinessCalendar = {
  offsetMinutes: number;
  weekdays: number[];
  shifts: { start: number; end: number }[];
  holidays: string[];
};
export class CalendarError extends Error {
  readonly code = 'WORKFLOW_CALENDAR_INVALID';
  constructor() {
    super('WORKFLOW_CALENDAR_INVALID');
  }
}
export function parseCalendar(value: unknown): BusinessCalendar {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CalendarError();
  const c = value as BusinessCalendar;
  if (
    Object.keys(c).some((k) => !['offsetMinutes', 'weekdays', 'shifts', 'holidays'].includes(k)) ||
    !Number.isInteger(c.offsetMinutes) ||
    c.offsetMinutes < -720 ||
    c.offsetMinutes > 840 ||
    c.offsetMinutes % 15 !== 0 ||
    !Array.isArray(c.weekdays) ||
    !c.weekdays.length ||
    c.weekdays.length > 7 ||
    c.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    new Set(c.weekdays).size !== c.weekdays.length ||
    !Array.isArray(c.shifts) ||
    !c.shifts.length ||
    c.shifts.length > 4 ||
    !Array.isArray(c.holidays) ||
    c.holidays.length > 366 ||
    c.holidays.some((d) => !isDate(d))
  )
    throw new CalendarError();
  const shifts = c.shifts
    .map((s) => {
      if (
        !s ||
        Object.keys(s).some((k) => !['start', 'end'].includes(k)) ||
        !Number.isInteger(s.start) ||
        !Number.isInteger(s.end) ||
        s.start < 0 ||
        s.end > 1440 ||
        s.end <= s.start
      )
        throw new CalendarError();
      return { ...s };
    })
    .sort((a, b) => a.start - b.start);
  if (shifts.some((s, i) => i > 0 && s.start < shifts[i - 1]!.end)) throw new CalendarError();
  return {
    offsetMinutes: c.offsetMinutes,
    weekdays: [...c.weekdays].sort(),
    shifts,
    holidays: [...new Set(c.holidays)].sort(),
  };
}
export function workflowDeadline(start: Date, minutes: number, calendar?: BusinessCalendar) {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 525600
  )
    throw new CalendarError();
  if (!calendar) return new Date(start.getTime() + minutes * 60000);
  const c = parseCalendar(calendar),
    offset = c.offsetMinutes * 60000,
    local = new Date(start.getTime() + offset),
    holidays = new Set(c.holidays);
  let day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
    remaining = minutes * 60000;
  for (let i = 0; i < 3660; i++, day += 86400000) {
    const date = new Date(day);
    if (!c.weekdays.includes(date.getUTCDay()) || holidays.has(date.toISOString().slice(0, 10)))
      continue;
    for (const shift of c.shifts) {
      const from = Math.max(start.getTime(), day + shift.start * 60000 - offset),
        until = day + shift.end * 60000 - offset;
      if (until <= from) continue;
      if (until - from >= remaining) return new Date(from + remaining);
      remaining -= until - from;
    }
  }
  throw new CalendarError();
}
