import type { Store } from "./persistence.js";
import { canonicalize, isWithin } from "./paths.js";

/**
 * Authorization roots and local limits (需求文档 §8.1, §7.3 policies table).
 */

const AUTHORIZED_ROOTS_KEY = "authorized_roots";
const LIMITS_KEY = "local_limits";

export interface LocalLimits {
  maxActiveTasks: number;
  dailyDelegateCap: number | null;
}

export const DEFAULT_LIMITS: LocalLimits = {
  maxActiveTasks: 1,
  dailyDelegateCap: null,
};

export class PolicyStore {
  constructor(private store: Store) {}

  authorizedRoots(): string[] {
    const rec = this.store.getPolicy(AUTHORIZED_ROOTS_KEY);
    if (!rec) return [];
    try {
      const v = JSON.parse(rec.valueJson) as unknown;
      return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
    } catch {
      return [];
    }
  }

  authorizeRoot(dir: string): string[] {
    const abs = canonicalize(dir);
    const roots = this.authorizedRoots();
    if (!roots.some((r) => r === abs)) roots.push(abs);
    this.store.setPolicy(AUTHORIZED_ROOTS_KEY, JSON.stringify(roots), new Date().toISOString());
    return roots;
  }

  revokeRoot(dir: string): string[] {
    const abs = canonicalize(dir);
    const roots = this.authorizedRoots().filter((r) => r !== abs);
    this.store.setPolicy(AUTHORIZED_ROOTS_KEY, JSON.stringify(roots), new Date().toISOString());
    return roots;
  }

  isAuthorized(target: string): boolean {
    return this.authorizedRoots().some((root) => isWithin(root, target));
  }

  limits(): LocalLimits {
    const rec = this.store.getPolicy(LIMITS_KEY);
    if (!rec) return { ...DEFAULT_LIMITS };
    try {
      return { ...DEFAULT_LIMITS, ...(JSON.parse(rec.valueJson) as Partial<LocalLimits>) };
    } catch {
      return { ...DEFAULT_LIMITS };
    }
  }

  setLimits(limits: Partial<LocalLimits>): LocalLimits {
    const merged = { ...this.limits(), ...limits };
    this.store.setPolicy(LIMITS_KEY, JSON.stringify(merged), new Date().toISOString());
    return merged;
  }
}
