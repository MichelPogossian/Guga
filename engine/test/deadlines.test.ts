import { describe, it, expect } from "vitest";
import { addBusinessDays, addCalendarDays, isBusinessDay, resolveRelativeDeadline, frenchHolidays } from "../src/modules/deadlines.js";

describe("échéances (§7.5)", () => {
  const received = new Date("2026-09-15T10:00:00Z"); // mardi
  it("connaît les jours fériés français", () => {
    expect(frenchHolidays(2026).has("2026-04-06")).toBe(true); // lundi de Pâques 2026
    expect(frenchHolidays(2026).has("2026-05-14")).toBe(true); // Ascension
    expect(isBusinessDay(new Date("2026-07-14T00:00:00Z"))).toBe(false);
  });
  it("ajoute des jours ouvrés", () => {
    expect(addBusinessDays(received, 3).toISOString().slice(0, 10)).toBe("2026-09-18");
    expect(addBusinessDays(received, 4).toISOString().slice(0, 10)).toBe("2026-09-21");
  });
  it("proroge un délai calendaire qui expire un week-end (art. 642 CPC)", () => {
    expect(addCalendarDays(received, 4).toISOString().slice(0, 10)).toBe("2026-09-21"); // samedi 19 → lundi 21
  });
  it("résout « avant vendredi 12h »", () => {
    expect(resolveRelativeDeadline("à faire signifier avant vendredi 12h impérativement", received)).toBe("2026-09-18T12:00");
  });
  it("résout « d'ici jeudi soir », « demain », « sous huitaine », dates explicites", () => {
    expect(resolveRelativeDeadline("me le renvoyer d'ici jeudi soir", received)).toBe("2026-09-17T18:00");
    expect(resolveRelativeDeadline("audience demain à 14h", received)).toBe("2026-09-16T14:00");
    expect(resolveRelativeDeadline("confirmer sous huitaine", received)).toBe("2026-09-23");
    expect(resolveRelativeDeadline("avant le 30 octobre 2026", received)).toBe("2026-10-30");
    expect(resolveRelativeDeadline("audience du 6 octobre", received)).toBe("2026-10-06");
  });
});
