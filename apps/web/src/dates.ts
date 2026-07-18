const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = dateFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    calendar: "iso8601",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  dateFormatters.set(timeZone, formatter);
  return formatter;
}

export function localDateInTimeZone(timeZone: string, instant = new Date()): string {
  const values = new Map(formatterFor(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) throw new RangeError(`Unable to resolve local date for ${timeZone}`);
  return `${year}-${month}-${day}`;
}

export function addLocalDateDays(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || !Number.isInteger(days)) throw new RangeError("Expected an ISO local date and integer day offset");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`Invalid ISO local date: ${value}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function defaultInventoryDates(timeZone: string, instant = new Date()) {
  const today = localDateInTimeZone(timeZone, instant);
  return {
    arrivalDate: addLocalDateDays(today, 1),
    departureDate: addLocalDateDays(today, 2)
  };
}
