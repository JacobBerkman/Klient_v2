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

export interface TemplateMapping {
  pdfFieldName: string;
  dataPath: string;
  transform?: string;
  repeaterGroupId?: string;
  confidence?: number;
}

export const canonicalTemplateModelPrinciples = [
  "one uploaded template aggregate owns document metadata, extracted fields, form blueprint, mappings, and versions",
  "published versions are immutable and suitable for audit and export replay",
  "form-builder and pdf-mapping interfaces edit the same underlying versioned aggregate",
  "auto-build creates draft blueprint versions instead of a parallel subsystem"
] as const;
