declare module "ical.js" {
  export class Time {
    icaltype: string;
    compare(other: Time): number;
    toJSDate(): Date;
    toString(): string;
    static fromString(s: string): Time;
    static fromJSDate(d: Date, useUTC?: boolean): Time;
  }

  export interface OccurrenceDetails {
    startDate: Time;
    endDate: Time;
    item?: unknown;
    recurrenceId?: Time;
  }

  export class Event {
    constructor(component: Component);
    summary: string;
    uid: string;
    description: string;
    startDate: Time;
    endDate: Time;
    isRecurring(): boolean;
    iterator(): { next(): Time | null };
    getOccurrenceDetails(time: Time): OccurrenceDetails;
  }

  export class Component {
    constructor(jCal: unknown);
    getFirstPropertyValue(name: string): unknown;
    getAllSubcomponents(name: string): Component[];
    getFirstSubcomponent(name: string): Component | null;
  }

  export function parse(ics: string): unknown;
}
