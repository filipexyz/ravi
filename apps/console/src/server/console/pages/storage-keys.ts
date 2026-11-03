export function isFinalObjectKeyForArtifact(input: {
  artifactId: string;
  artifactVersionId: string;
  key: string;
  path: string;
}) {
  const marker = `/artifact/${input.artifactId}/version/${input.artifactVersionId}/`;
  const markerIndex = input.key.indexOf(marker);
  if (markerIndex < 0) return false;

  const prefix = input.key.slice(0, markerIndex);
  const objectPath = input.key.slice(markerIndex + marker.length);
  return /^org\/[^/]+\/project\/[^/]+$/.test(prefix) && objectPath === input.path;
}
