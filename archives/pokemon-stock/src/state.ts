import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProductState {
  available: boolean;
  quantityDisabled: boolean;
  cartButtonDefault: boolean;
  orderTag: string;
  title: string;
}

export interface PokemonStockState {
  targets: Record<string, ProductState>;
  lastMonitorAlertAt?: string;
}

const EMPTY_STATE: PokemonStockState = { targets: {} };

export class StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<PokemonStockState> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PokemonStockState>;
      const targetsRaw = parsed.targets;
      const targets: Record<string, ProductState> = {};
      if (targetsRaw && typeof targetsRaw === "object") {
        for (const [url, s] of Object.entries(targetsRaw)) {
          if (!s || typeof s !== "object") continue;
          targets[url] = {
            available: s.available === true,
            quantityDisabled: s.quantityDisabled === true,
            cartButtonDefault: s.cartButtonDefault === true,
            orderTag: typeof s.orderTag === "string" ? s.orderTag : "",
            title: typeof s.title === "string" ? s.title : "(unknown)",
          };
        }
      }
      return {
        targets,
        lastMonitorAlertAt:
          typeof parsed.lastMonitorAlertAt === "string" ? parsed.lastMonitorAlertAt : undefined,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE };
      throw err;
    }
  }

  async save(state: PokemonStockState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.path);
  }
}
