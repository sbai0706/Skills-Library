import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const referenceDirectory = new URL("./", import.meta.url);

function readReference(filename) {
  const file = new URL(filename, referenceDirectory);
  return YAML.parse(readFileSync(fileURLToPath(file), "utf8"));
}

export function loadAccountIntelligenceReferences() {
  return {
    signalTaxonomy: readReference("signal-taxonomy.yaml"),
    personas: readReference("personas.yaml"),
    offerings: readReference("offerings.yaml"),
  };
}
