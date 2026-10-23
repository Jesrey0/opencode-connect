import * as z from "zod/v4";

const unionVariants = new WeakMap<object, z.ZodObject[]>();

export function variantsOf(schema: object): readonly z.ZodObject[] {
  const variants = unionVariants.get(schema);
  if (!variants) throw new Error("schema is not an exposed union");
  return variants;
}

export function withoutFields(schema: z.ZodObject, ...keys: string[]): z.ZodObject {
  const shape = Object.fromEntries(Object.entries(schema.shape).filter(([field]) => !keys.includes(field)));
  const object = z.object(shape).strict();
  const error = schema.def.error as z.core.$ZodErrorMap | undefined;
  return object.clone({ ...object.def, checks: schema.def.checks, error }).meta(schema.meta() ?? {});
}

// Publish model-visible fields alongside the union's strict variant constraints.
// Metadata only affects discovery; the discriminated union is the sole parser.
export function exposedUnion<K extends string, O extends readonly [z.ZodObject, ...z.ZodObject[]]>(key: K, options: O) {
  const variants = options.map((option) => {
    const strict = option.strict();
    const error = strict.def.error as z.core.$ZodErrorMap | undefined;
    // Keep refinements and strict rejection, but do not echo arbitrary caller keys
    // into SDK validation errors. Other field/bound errors retain their detail.
    return strict.clone({ ...strict.def, error: (issue: z.core.$ZodRawIssue) => issue.code === "unrecognized_keys"
      ? "Unrecognized field(s) for selected variant; use only its documented fields"
      : error?.(issue) }).meta(option.meta() ?? {});
  }) as unknown as O;
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
  const exposed = union.meta({ type: "object", properties, required });
  unionVariants.set(exposed, [...variants]);
  return exposed;
}
