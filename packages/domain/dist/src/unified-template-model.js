export const canonicalTemplateModelPrinciples = [
    "one uploaded template aggregate owns document metadata, extracted fields, form blueprint, mappings, and versions",
    "published versions are immutable and suitable for audit and export replay",
    "form-builder and pdf-mapping interfaces edit the same underlying versioned aggregate",
    "auto-build creates draft blueprint versions instead of a parallel subsystem"
];
