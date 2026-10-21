/**
 * Contracts for the tool harness and agent loop. Kept dependency-free so the
 * parser, grammar generator, validator and loop can be built and tested in
 * isolation.
 */

/** JSON Schema subset the harness understands (validator, GBNF, prompts). */
export type JsonSchema =
  | {
      type: 'string';
      description?: string;
      enum?: string[];
      minLength?: number;
      maxLength?: number;
    }
  | { type: 'integer' | 'number'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema; maxItems?: number }
  | {
      type: 'object';
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: string[];
      /** Free-form object (e.g. extract's output schema) when true. */
      additionalProperties?: boolean;
    };

export interface ObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  /** One line, imperative, for the model. */
  description: string;
  parameters: ObjectSchema;
  /** Ends the run (done, askUser). */
  terminal?: boolean;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The model's stated reasoning for this step, if it gave one. */
  thought?: string;
}

export type ParseResult =
  | { ok: true; call: ToolCall; /** Which syntax matched, for diagnostics. */ format: string }
  | { ok: false; error: string };

export type ToolTier = 'native' | 'constrained' | 'text';

export type ValidationResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
