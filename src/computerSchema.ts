import * as z from "zod/v4";
import { exposedUnion } from "./schema.js";

const handle = z.string().regex(/^(?:0[xX])?[0-9a-fA-F]{1,16}$/).refine((s) => {
  const hex = s.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return false;
  const n = BigInt(`0x${hex}`);
  return n > 0n && n <= 0x7fffffffffffffffn;
}).describe("Nonzero WCU hexadecimal window handle, e.g. 0x1234.");
export { handle as windowHandleSchema };
const exactText = z.string().min(1).max(256).regex(/\S/);
const criteriaShape = { automationId: exactText.optional(), name: exactText.optional(), controlType: exactText.optional() };
const hasCriteria = (s: { automationId?: string; name?: string; controlType?: string }) => Object.values(s).some((value) => typeof value === "string");
const criteriaMeta = { anyOf: ["automationId", "name", "controlType"].map((field) => ({ required: [field] })) };
const ancestor = z.object(criteriaShape).strict().refine(hasCriteria).meta(criteriaMeta);
export const locatorSchema = z.object({ ...criteriaShape, ancestor: ancestor.optional() }).strict().refine(hasCriteria).meta(criteriaMeta)
  .describe("Exact, case-sensitive criteria; at least one field, with at most one ancestor scope. No fuzzy matching or caching.");
const located = { handle, locator: locatorSchema };
export const computerObserveSchema = exposedUnion("type", [
  z.object({ type: z.literal("capabilities") }),
  z.object({ type: z.literal("windows") }),
  z.object({ type: z.literal("state"), handle }),
  z.object({ type: z.literal("find"), ...located, maxResults: z.number().int().min(1).max(100).optional(), maxNodes: z.number().int().min(1).max(2000).optional(), maxDepth: z.number().int().min(0).max(20).optional() }),
  z.object({ type: z.literal("inspect"), ...located }),
]);
const compose = { ...located, activate: z.boolean().optional().meta({ default: false }), readback: z.boolean().optional().meta({ default: true }) };
const coordinate = z.number().int().min(-2147483648).max(2147483647);
const modifiers = z.array(z.union([z.literal(16), z.literal(17), z.literal(18)])).max(3).meta({ uniqueItems: true }).optional();
const chord = z.object({ key: z.number().int().min(1).max(254), modifiers }).strict().refine((s) => {
  const keys = s.modifiers ?? [];
  return new Set(keys).size === keys.length && !keys.some((key) => key === s.key);
}).describe("Windows virtual-key code; modifiers are unique Shift=16, Ctrl=17, Alt=18 and cannot contain key.");
const dragShape = {
  points: z.array(z.object({ x: coordinate, y: coordinate }).strict()).min(2).max(128),
  durationMs: z.number().int().min(0).max(5000).optional(),
  stepsPerSegment: z.number().int().min(1).max(511).optional(),
};
// WCU emits the initial point plus stepsPerSegment moves per segment.
const dragMeta = { anyOf: [
  { not: { required: ["stepsPerSegment"] } },
  ...Array.from({ length: 127 }, (_, i) => ({ properties: { points: { minItems: i + 2, maxItems: i + 2 }, stepsPerSegment: { maximum: Math.floor(511 / (i + 1)) } } })),
] };
export const computerInteractSchema = exposedUnion("action", [
  z.object({ action: z.literal("activate"), handle }),
  z.object({ action: z.literal("focus"), ...compose }),
  z.object({ action: z.literal("setValue"), ...compose, value: z.string().max(4096) }),
  z.object({ action: z.literal("invoke"), ...compose }),
  z.object({ action: z.literal("keySequence"), chords: z.array(chord).min(1).max(32), handle: handle.optional(), activate: z.boolean().optional().meta({ default: false }) }).meta({ allOf: [{ if: { properties: { activate: { const: true } }, required: ["activate"] }, then: { required: ["handle"] } }] }),
  z.object({ action: z.literal("move"), x: coordinate, y: coordinate }),
  z.object({ action: z.literal("click"), x: coordinate, y: coordinate, button: z.enum(["left", "right"]), count: z.union([z.literal(1), z.literal(2)]) }),
  z.object({ action: z.literal("scroll"), delta: z.number().int().min(-1200).max(1200).refine((n) => n !== 0).meta({ not: { const: 0 } }), x: coordinate.optional(), y: coordinate.optional() }).meta({ dependentRequired: { x: ["y"], y: ["x"] } }),
  z.object({ action: z.literal("drag"), ...dragShape }).meta(dragMeta),
  z.object({ action: z.literal("close"), handle }),
]).refine((s) => s.action !== "keySequence" || !s.activate || !!s.handle, "activate=true requires handle")
  .refine((s) => s.action !== "scroll" || (s.x === undefined) === (s.y === undefined), "scroll requires both x and y or neither")
  .refine((s) => s.action !== "drag" || s.stepsPerSegment === undefined || 1 + (s.points.length - 1) * s.stepsPerSegment <= 512, "drag exceeds 512 move positions");

const waitPredicateSchema = exposedUnion("type", [
  z.object({ type: z.enum(["exists", "focused", "enabled"]), expected: z.boolean() }),
  z.object({ type: z.enum(["valueEquals", "nameEquals"]), expected: z.string().max(4096).nullable() }),
]);
const waitConditionSchema = exposedUnion("type", [
  z.object({ type: z.literal("windowPresent"), title: z.string().max(4096).optional(), handle: handle.optional(), expected: z.boolean() })
    .meta({ oneOf: [{ required: ["title"], not: { required: ["handle"] } }, { required: ["handle"], not: { required: ["title"] } }] }),
  z.object({ type: z.literal("elementState"), ...located, predicate: waitPredicateSchema }),
]).refine((s) => s.type !== "windowPresent" || (s.title === undefined) !== (s.handle === undefined), "provide exactly one title or handle");
export const computerWaitSchema = z.object({
  action: z.literal("waitFor"), condition: waitConditionSchema,
  timeoutMs: z.number().int().min(0).max(10000).optional().meta({ default: 3000 }),
  pollIntervalMs: z.number().int().min(50).max(1000).optional().meta({ default: 100 }),
}).strict();
export const computerSequenceSchema = z.object({
  steps: z.array(z.union([computerInteractSchema, computerWaitSchema])).min(1).max(32)
    .describe("1..32 explicit actions or bounded deterministic waits. Sequential, stop on first failure; no screenshots, code, loops or branches."),
}).strict();
export type ComputerWait = z.infer<typeof computerWaitSchema>;
export type ComputerSequence = z.infer<typeof computerSequenceSchema>;
export const computerScreenshotSchema = z.object({ handle: handle.optional() }).strict();
export type ComputerObserve = z.infer<typeof computerObserveSchema>;
export type ComputerInteract = z.infer<typeof computerInteractSchema>;

const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const windowShape = { handle: z.string(), processId: z.number().int(), title: z.string(), bounds: rect, executablePath: z.string().nullable(), processName: z.string().nullable() };
export const windowSchema = z.object(windowShape);
export const windowStateSchema = z.object({ ...windowShape, visible: z.boolean(), minimized: z.boolean(), maximized: z.boolean(), foreground: z.boolean(), enabled: z.boolean() });
const elementShape = { handle: z.string(), name: z.string().nullable(), controlType: z.string(), automationId: z.string().nullable(), enabled: z.boolean(), focused: z.boolean(), offscreen: z.boolean(), bounds: rect, canInvoke: z.boolean(), canSetValue: z.boolean() };
export const elementStateSchema = z.object({ ...elementShape, value: z.string().nullable() });
// WCU emits null for omitted locator fields; input locators deliberately omit them.
const returnedCriteria = { automationId: z.string().nullable(), name: z.string().nullable(), controlType: z.string().nullable() };
const returnedLocator = z.object({ ...returnedCriteria, ancestor: z.object({ ...returnedCriteria, ancestor: z.null() }).nullable() });
export const findSchema = z.object({ handle: z.string(), elements: z.array(z.object({ state: z.object(elementShape), locator: returnedLocator.nullable(), locatorUnique: z.boolean() })), visitedNodes: z.number().int().nonnegative(), complete: z.boolean() });
const limitNames = ["maxLocatorDepth", "maxLocatorNodes", "maxLocatorTextLength", "maxFindResults", "maxKeySequence", "maxVirtualKey", "maxWheelDelta", "maxTextLength", "maxValueLength", "maxTreeDepth", "maxTreeNodes", "maxClickCount"] as const;
export const capabilitiesSchema = z.object({ apiVersion: z.literal("v1"), hostVersion: z.string(), locatorFields: z.array(z.string()), semanticActions: z.array(z.string()), inputActions: z.array(z.string()), windowActions: z.array(z.string()), limits: z.object(Object.fromEntries(limitNames.map((name) => [name, z.number().int().positive()])) as Record<typeof limitNames[number], z.ZodNumber>).extend({ maxDragPoints: z.number().int().positive().optional(), maxDragDurationMs: z.number().int().nonnegative().optional(), maxDragSteps: z.number().int().positive().optional() }) });
export const activationSchema = z.object({ handle: z.string(), isForeground: z.boolean() });
export const actionSchema = z.object({ success: z.boolean() });
export const closeSchema = z.object({ handle: z.string(), requestPosted: z.boolean(), disappeared: z.boolean() });
const dragResultSchema = z.object({ success: z.literal(true), metadata: z.object({ elapsedMs: z.number().nonnegative(), emittedInputCount: z.number().int().min(1).max(514), steps: z.number().int().min(1).max(511) }) });
const interactOutputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("activate"), result: activationSchema }).strict(),
  z.object({ action: z.literal("focus"), result: elementStateSchema, activation: activationSchema.optional(), state: elementStateSchema.optional() }).strict(),
  z.object({ action: z.enum(["setValue", "invoke"]), result: actionSchema, activation: activationSchema.optional(), state: elementStateSchema.optional() }).strict(),
  z.object({ action: z.literal("keySequence"), result: actionSchema, activation: activationSchema.optional() }).strict(),
  z.object({ action: z.enum(["move", "click", "scroll"]), result: actionSchema }).strict(),
  z.object({ action: z.literal("drag"), result: dragResultSchema }).strict(),
  z.object({ action: z.literal("close"), result: closeSchema }).strict(),
]);
const waitResultSchema = z.object({ action: z.literal("waitFor"), satisfied: z.literal(true), polls: z.number().int().positive() }).strict();
const stepTiming = { index: z.number().int().min(0).max(31), elapsedMs: z.number().nonnegative() };
export const computerSequenceOutputSchema = z.object({
  success: z.boolean(),
  results: z.array(z.discriminatedUnion("success", [
    z.object({ ...stepTiming, success: z.literal(true), result: z.union([interactOutputSchema, waitResultSchema]) }).strict(),
    z.object({ ...stepTiming, success: z.literal(false), action: z.enum(["activate", "focus", "setValue", "invoke", "keySequence", "move", "click", "scroll", "drag", "close", "waitFor"]), error: z.object({ code: z.enum(["wait_timeout", "bridge", "transport", "timeout", "http", "too_large", "png", "invalid_json", "activation", "element_not_found", "locator_not_found", "operation_failed"]), message: z.string(), completedSteps: z.number().int().min(0).max(3).optional(), status: z.number().int().min(100).max(599).optional(), polls: z.number().int().positive().optional() }).strict() }).strict(),
  ])).min(1).max(32),
  totalElapsedMs: z.number().nonnegative(), completedSteps: z.number().int().min(0).max(32), stoppedAt: z.number().int().min(0).max(31).nullable(),
}).strict();
export const computerOutputSchemas = {
  observe: z.discriminatedUnion("type", [
    z.object({ type: z.literal("capabilities"), data: capabilitiesSchema }).strict(),
    z.object({ type: z.literal("windows"), data: z.array(windowSchema) }).strict(),
    z.object({ type: z.literal("state"), data: windowStateSchema }).strict(),
    z.object({ type: z.literal("find"), data: findSchema }).strict(),
    z.object({ type: z.literal("inspect"), data: elementStateSchema }).strict(),
  ]),
  interact: interactOutputSchema,
  sequence: computerSequenceOutputSchema,
  screenshot: z.object({ target: z.enum(["desktop", "window"]), handle: z.string().optional(), mimeType: z.literal("image/png"), size: z.number().int().min(1).max(1_048_576), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
};
