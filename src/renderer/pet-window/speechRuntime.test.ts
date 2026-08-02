import { describe, expect, it } from "vitest";
import type { PetDefinition } from "../../shared/types/pet";
import { shouldShowEventSubtitle } from "./speechRuntime";

describe("event subtitle presentation", () => {
  it("defaults to visible for old configs", () => {
    expect(shouldShowEventSubtitle(undefined, "click")).toBe(true);
    expect(shouldShowEventSubtitle({ eventSettings: {} } as PetDefinition, "click")).toBe(true);
  });

  it("hides only the configured event subtitle", () => {
    const pet = {
      eventSettings: {
        click: { showSubtitle: false },
        idle: { showSubtitle: true }
      }
    } as PetDefinition;

    expect(shouldShowEventSubtitle(pet, "click")).toBe(false);
    expect(shouldShowEventSubtitle(pet, "idle")).toBe(true);
    expect(shouldShowEventSubtitle(pet, "ready")).toBe(true);
  });
});
