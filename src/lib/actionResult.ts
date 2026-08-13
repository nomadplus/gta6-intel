import { ZodError } from "zod";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function safeAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, error: err.issues.map((e) => e.message).join("; ") };
    }
    if (err instanceof Error) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Unknown error" };
  }
}

/** Converts FormData into a plain object; listed fields are collected as arrays (e.g. multi-select). */
export function formDataToObject(formData: FormData, arrayFields: string[] = []): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    if (arrayFields.includes(key)) {
      obj[key] = formData.getAll(key).filter((v) => v !== "");
    } else {
      const v = formData.get(key);
      obj[key] = v === "" ? undefined : v;
    }
  }
  return obj;
}
