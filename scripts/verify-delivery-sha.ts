const entries = process.argv.slice(2).map((entry) => entry.trim()).filter(Boolean);

if (entries.length < 2) {
  console.error("Usage: bun run delivery:verify-sha <implemented-sha> <reviewed-sha> [pr-sha] [package-sha] [deployed-sha]");
  process.exit(2);
}

for (const entry of entries) {
  if (!/^[0-9a-f]{7,40}$/i.test(entry)) {
    console.error(`Invalid git SHA: ${entry}`);
    process.exit(2);
  }
}

const normalized = entries.map((entry) => entry.toLowerCase());
if (new Set(normalized).size !== 1) {
  console.error(`Delivery SHA mismatch: ${entries.join(" != ")}`);
  process.exit(1);
}

console.log(`Delivery SHA verified across ${entries.length} stages: ${entries[0]}`);
