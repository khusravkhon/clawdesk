import { TodayDto } from "@clawdesk/shared";

type SectionKey = "connection" | "approvals" | "notes" | "search" | "reminders" | "schedules";
type Readers = { [K in SectionKey]: () => Promise<NonNullable<TodayDto[K]["data"]>> | NonNullable<TodayDto[K]["data"]> };

/** A failed section keeps its last observation, explicitly marked unknown, without hiding other sections. */
export class TodayService {
  #last: Partial<TodayDto> = {};
  #inflight: Promise<TodayDto> | null = null;
  constructor(private readonly readers: Readers, private readonly timeZone: () => string, private readonly now = Date.now) {}

  get(): Promise<TodayDto> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#read().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #read(): Promise<TodayDto> {
    const result: Record<string, unknown> = { generatedAt: this.now(), timeZone: this.timeZone() };
    await Promise.all((Object.keys(this.readers) as SectionKey[]).map(async (key) => {
      try {
        const data = await this.readers[key]();
        const checkedAt = key === "search" ? (data as NonNullable<TodayDto["search"]["data"]>).checkedAt : this.now();
        result[key] = TodayDto.shape[key].parse({ state: "available", checkedAt, data });
      } catch {
        const last = this.#last[key];
        result[key] = { state: "unknown", checkedAt: last?.checkedAt ?? null, data: last?.data ?? null };
      }
    }));
    const dto = TodayDto.parse(result);
    this.#last = dto;
    return dto;
  }
}
