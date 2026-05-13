import { z } from "zod";
import { Uuid, Timestamps } from "./common.js";

// Custom fields declare typed views over `metadata.<key>` on tickets.
// Storage stays in the metadata JSONB column — defining a field doesn't
// migrate existing data, and deleting one doesn't drop any data. The
// underlying read path also accepts type-mismatched values (so a ticket
// written before a field was declared still loads); the typed view
// affects UI display, create-form input, and filter parsing.

export const CustomFieldType = z.enum(["text", "number", "boolean", "url", "select"]);
export type CustomFieldType = z.infer<typeof CustomFieldType>;

// For type=select. The Cogitation Engine's `mode` enum and the
// servo-signal scaffold's `template` enum both live in pipeline code as
// the source of truth — switchyard's select options can drift. Mitigation
// strategies: keep this list in lockstep at deploy time, or seed via the
// imperium-loop fields script and treat code-as-truth (preferred).
export const CustomFieldOptions = z.object({
  values: z.array(z.string().min(1).max(100)).min(1).max(100),
});
export type CustomFieldOptions = z.infer<typeof CustomFieldOptions>;

// Identifier matched against `metadata.<key>`. Lowercase + digits +
// underscores; must start with a letter. The DB CHECK enforces the same
// shape, so write-side rejection lands at the API boundary regardless.
const CustomFieldKey = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase identifier (letters, digits, underscores; must start with a letter)");

export const CustomField = z
  .object({
    id: Uuid,
    project_id: Uuid.nullable(),
    key: CustomFieldKey,
    label: z.string().min(1).max(200),
    type: CustomFieldType,
    options: CustomFieldOptions.nullable(),
    show_on_card: z.boolean(),
    show_on_create_form: z.boolean(),
    show_on_filter_bar: z.boolean(),
  })
  .merge(Timestamps);
export type CustomField = z.infer<typeof CustomField>;

export const CreateCustomField = z
  .object({
    // null/missing = global; UUID = project-scoped.
    project_id: Uuid.nullable().optional(),
    key: CustomFieldKey,
    label: z.string().min(1).max(200),
    type: CustomFieldType,
    options: CustomFieldOptions.optional(),
    show_on_card: z.boolean().default(false),
    show_on_create_form: z.boolean().default(false),
    show_on_filter_bar: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.type === "select" && (!data.options || data.options.values.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "type=select requires non-empty options.values",
        path: ["options"],
      });
    }
    if (data.type !== "select" && data.options !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "options is only valid for type=select",
        path: ["options"],
      });
    }
  });
export type CreateCustomField = z.infer<typeof CreateCustomField>;

// key, project_id, and type are immutable after creation. Renaming or
// retyping would silently break tickets carrying the old shape; recreate
// the field instead.
export const UpdateCustomField = z.object({
  label: z.string().min(1).max(200).optional(),
  options: CustomFieldOptions.nullable().optional(),
  show_on_card: z.boolean().optional(),
  show_on_create_form: z.boolean().optional(),
  show_on_filter_bar: z.boolean().optional(),
});
export type UpdateCustomField = z.infer<typeof UpdateCustomField>;
