import { TodayDto } from "@clawdesk/shared";

type SectionKey = Exclude<keyof TodayDto, "generatedAt" | "timeZone">;
type Readers = { [K in SectionKey]: () => Promise<NonNullable<TodayDto[K]["data"]>> | NonNullable<TodayDto[K]["data"]> };

/** A failed section keeps its last observation, explicitly marked unknown, without hiding other sections. */
export class TodayService {
  #last: Partial<TodayDto> = {};
  #inflight: Promise<TodayDto> | null = null;
  #reading = new Map<SectionKey, Promise<unknown>>();
  constructor(private readonly readers: Readers, private readonly timeZone: () => string, private readonly now = Date.now, private readonly timeoutMs = 2_500) {}

  get(): Promise<TodayDto> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#read().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #observe(key: SectionKey): Promise<unknown> {
    let reading = this.#reading.get(key);
    if (!reading) {
      reading = Promise.resolve(this.readers[key]()).finally(() => { this.#reading.delete(key); });
      this.#reading.set(key, reading);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(reject, this.timeoutMs); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #read(): Promise<TodayDto> {
    const result: Record<string, unknown> = { generatedAt: this.now(), timeZone: this.timeZone() };
    await Promise.all((Object.keys(this.readers) as SectionKey[]).map(async (key) => {
      try {
        const data = await this.#observe(key);
        const checkedAt = key === "search" || key === "budget" ? (data as { checkedAt: number | null }).checkedAt : this.now();
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
