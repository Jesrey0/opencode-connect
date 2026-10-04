import * as z from "zod/v4";

// Publish model-visible fields alongside the union's strict variant constraints.
// Metadata only affects discovery; the discriminated union is the sole parser.
export function exposedUnion<K extends string, O extends readonly [z.ZodObject, ...z.ZodObject[]]>(key: K, options: O) {
  const variants = options.map((option) => option.strict().meta(option.meta() ?? {})) as unknown as O;
  const union = z.discriminatedUnion(key, variants);
  const oneOf = variants.map((variant) => {
    const { $schema, ...schema } = z.toJSONSchema(variant, { io: "input", target: "draft-2020-12" });
    return schema;
  });
  const properties: Record<string, unknown> = {};
  const names = new Set(oneOf.flatMap((variant) => Object.keys(variant.properties ?? {})));
  for (const name of names) {
    const fields = oneOf.flatMap((variant) => variant.properties?.[name] ? [variant.properties[name]] : []);
    const unique = [...new Map(fields.map((field) => [JSON.stringify(field), field])).values()];
    const schemas = unique as Record<string, unknown>[];
    const finite = schemas.every((field) => typeof field.const === "string" || Array.isArray(field.enum));
    const property = unique.length === 1 ? unique[0] : finite
      ? { type: "string", enum: [...new Set(schemas.flatMap((field) => "const" in field ? [field.const] : field.enum as unknown[]))] }
      : schemas.every((field) => field.type === schemas[0].type)
        ? Object.fromEntries(Object.entries(schemas[0]).filter(([key, value]) => schemas.every((field) => JSON.stringify(field[key]) === JSON.stringify(value))))
        : { anyOf: unique };
    properties[name] = property;
  }
  const required = (oneOf[0].required ?? []).filter((name) => oneOf.every((variant) => variant.required?.includes(name)));
  return union.meta({ type: "object", properties, required });
}
