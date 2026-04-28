/**
 * OpenAPI 3.1 types — minimal subset emitted by the Ravi SDK emitter.
 *
 * Not a full OpenAPI typing library; only fields the emitter actually
 * produces. Schema bodies are `unknown` because they are JSON Schema
 * Draft 2020-12 objects whose precise shape depends on the source Zod.
 */

export type JsonSchema = Record<string, unknown>;

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface SecurityScheme {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect";
  scheme?: string;
  bearerFormat?: string;
  description?: string;
}

export type SecurityRequirement = Record<string, string[]>;

export interface OpenApiResponse {
  description: string;
  content?: {
    "application/json": { schema: JsonSchema };
  };
}

export interface OpenApiRequestBody {
  required: boolean;
  content: {
    "application/json": { schema: JsonSchema };
  };
}

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: SecurityRequirement[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

export interface OpenApiPathItem {
  post: OpenApiOperation;
}

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiComponents {
  schemas?: Record<string, JsonSchema>;
  securitySchemes?: Record<string, SecurityScheme>;
}

export interface OpenApiSpec {
  openapi: "3.1.0";
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  tags?: OpenApiTag[];
  security?: SecurityRequirement[];
  paths: Record<string, OpenApiPathItem>;
  components?: OpenApiComponents;
}
