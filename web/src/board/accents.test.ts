import { describe, expect, it } from "vitest";
import { STATES } from "../types";
import { stateAccentClass } from "./accents";

describe("stateAccentClass", () => {
  it("maps every known state to a distinct accent class", () => {
    const classes = STATES.map(stateAccentClass);
    expect(classes).toEqual([
      "accent-backlog",
      "accent-todo",
      "accent-inprogress",
      "accent-inreview",
      "accent-done",
      "accent-cancelled",
    ]);
    expect(new Set(classes).size).toBe(STATES.length);
  });

  it("returns an empty string for unknown states", () => {
    expect(stateAccentClass("Bogus")).toBe("");
  });
});
