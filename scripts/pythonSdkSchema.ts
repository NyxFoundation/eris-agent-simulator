import { createGenerator } from "ts-json-schema-generator";
import { actionJsonSchema } from "../sdk/src/actionSchema.js";
import { ACTION_TYPES_BY_PROTOCOL } from "../sdk/src/action.js";
import type { ProtocolId } from "../sdk/src/types.js";

export const snakeCase = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

// Action validation lives in Zod; observations are declared in types.ts. Generate from each
// existing authority instead of maintaining a second, incomplete observation schema by hand.
export function pythonSchemas() {
  const action = actionJsonSchema(
    Object.keys(ACTION_TYPES_BY_PROTOCOL) as ProtocolId[],
  );
  const members = action.anyOf as Array<{
    properties: { type: { const: string } };
    title?: string;
    required?: string[];
  }>;
  for (const member of members) {
    const type = member.properties.type.const;
    member.title = `${type[0].toUpperCase()}${type.slice(1)}Action`;
  }
  const references = new Map(
    members.map(({ title, ...schema }) => [
      JSON.stringify(schema),
      `#/$defs/${title}`,
    ]),
  );
  const reuse = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const ref = references.get(JSON.stringify(value));
    if (ref) return { $ref: ref };
    if (Array.isArray(value)) return value.map(reuse);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, reuse(v)]),
    );
  };
  // Bundle leaves are the exact same schema objects as top-level actions. Give them shared names
  // so bundle(actions=[swap(...)]) accepts the typed model rather than a duplicate generated type.
  const definitions = Object.fromEntries(
    members.map((m) => [m.title!, reuse(m)]),
  );
  const observation = createGenerator({
    path: "sdk/src/types.ts",
    tsconfig: "tsconfig.json",
    type: "AgentObservation",
    skipTypeCheck: true,
  }).createSchema("AgentObservation");
  return {
    action: {
      ...action,
      title: "Action",
      anyOf: members.map((m) => ({ $ref: `#/$defs/${m.title}` })),
      $defs: definitions,
    },
    observation,
    members,
  };
}
