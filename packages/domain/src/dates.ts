import { DomainError } from "@qintopia/contracts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_SERVICE_NIGHTS = 366;

export function parseLocalDate(value: string): Date {
  if (!ISO_DATE.test(value)) throw new DomainError("VALIDATION_ERROR", `Invalid local date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new DomainError("VALIDATION_ERROR", `Invalid local date: ${value}`);
  }
  return date;
}

export function enumerateServiceDates(arrivalDate: string, departureDate: string): string[] {
  const arrival = parseLocalDate(arrivalDate);
  const departure = parseLocalDate(departureDate);
  if (departure <= arrival) {
    throw new DomainError("VALIDATION_ERROR", "departureDate must be after arrivalDate");
  }
  const nightCount = (departure.getTime() - arrival.getTime()) / 86_400_000;
  if (nightCount > MAX_SERVICE_NIGHTS) {
    throw new DomainError("VALIDATION_ERROR", `Stay cannot exceed ${MAX_SERVICE_NIGHTS} service nights`);
  }
  const dates: string[] = [];
  for (let cursor = arrival.getTime(); cursor < departure.getTime(); cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
