export type MappingTransformType =
  | "none"
  | "date"
  | "phone"
  | "currency"
  | "checkbox"
  | "number"
  | "uppercase"
  | "lowercase"
  | "trim";

export interface MappingTransform {
  type: MappingTransformType;
  options?: Record<string, unknown>;
}

export interface DirectTemplateMapping {
  id: string;
  kind: "direct";
  pdfFieldName: string;
  sourcePath: string;
  transform?: MappingTransform;
  confidence?: number;
}

export interface CompositeTemplateMapping {
  id: string;
  kind: "composite";
  pdfFieldName: string;
  sourcePaths: string[];
  joinWith?: string;
  transform?: MappingTransform;
  confidence?: number;
}

export interface SplitTemplateMapping {
  id: string;
  kind: "split";
  sourcePath: string;
  delimiter: string;
  targets: Array<{
    pdfFieldName: string;
    index: number;
    transform?: MappingTransform;
  }>;
  confidence?: number;
}

export interface RepeaterTemplateMapping {
  id: string;
  kind: "repeater";
  repeaterGroupId: string;
  sourceCollectionPath: string;
  itemMappings: Array<
    Omit<DirectTemplateMapping, "kind" | "id"> | Omit<CompositeTemplateMapping, "kind" | "id">
  >;
  confidence?: number;
}

export type TemplateMapping =
  | DirectTemplateMapping
  | CompositeTemplateMapping
  | SplitTemplateMapping
  | RepeaterTemplateMapping;

export interface AutoMapSuggestion {
  mapping: TemplateMapping;
  confidence: number;
  rationale: string;
}

export interface CanonicalTemplateAggregate {
  templateId: string;
  templateKey: string;
  firmId: string;
  artifact: UploadedArtifact;
  versions: TemplateVersion[];
  publishedVersionId?: string;
}

export interface UploadedArtifact {
  storageKey: string;
  fileName: string;
  kind: "pdf_template";
  ingestion: {
    extractedAt?: string;
    extractor: "acroform" | "ocr" | "manual";
  };
}

export interface TemplateVersion {
  id: string;
  versionNumber: number;
  status: "draft" | "published" | "superseded" | "archived";
  blueprint: BlueprintDefinition;
  mappings: TemplateMapping[];
  suggestions?: AutoMapSuggestion[];
  createdAt: string;
  createdByUserId: string;
}

export interface BlueprintDefinition {
  sections: BlueprintSection[];
  repeatableGroups: RepeatableGroup[];
}

export interface BlueprintSection {
  id: string;
  title: string;
  order: number;
  fieldKeys: string[];
}

export interface RepeatableGroup {
  id: string;
  key: string;
  sourceCollectionPath: string;
  maxInstances?: number;
}

export const mappingTransformCatalog: MappingTransformType[] = [
  "none",
  "date",
  "phone",
  "currency",
  "checkbox",
  "number",
  "uppercase",
  "lowercase",
  "trim"
];

export const canonicalTemplateModelPrinciples = [
  "one uploaded template aggregate owns document metadata, extracted fields, form blueprint, mappings, and versions",
  "published versions are immutable and suitable for audit and export replay",
  "form-builder and pdf-mapping interfaces edit the same underlying versioned aggregate",
  "auto-build creates draft blueprint versions instead of a parallel subsystem",
  "mapping editor supports direct, composite, split, and repeater mappings with typed transforms",
  "auto-map suggestions include confidence scoring and rationale"
] as const;
